import { EventEmitter } from 'node:events';
import { CHANNEL_ID, GUILD_ID, OTHER_CHANNEL_ID } from '../fixtures.js';

// Interactions that define this symbol are told which tracked handler run they belong to.
export const INVOKED = Symbol('fake-discord-invoked');

const BOT = { id: 'bot-user', bot: true };

const createGuild = () => {
  let failing = false;
  let missing = false;
  const members = {
    calls: [],
    avatars: {},
    setFailing: (x) => {
      failing = x;
    },
    setMissing: (x) => {
      missing = x;
    },
    async fetch({ query, limit }) {
      members.calls.push({ query, limit });
      if (failing) throw new Error('fake discord: member fetch failed');
      const avatar = query in members.avatars ? members.avatars[query] : `https://cdn.example/avatars/${query}.png`;
      return { first: () => (missing ? undefined : { displayAvatarURL: () => avatar }) };
    },
  };
  return { id: GUILD_ID, members };
};

const createChannel = (id, guild, nextId) => {
  const channel = { id, guild, guildId: guild.id, sent: [], sentMessages: [] };
  channel.send = async (payload) => {
    channel.sent.push(payload);
    const message = makeBotMessage(nextId(), payload, channel);
    channel.sentMessages.push(message);
    return message;
  };
  return channel;
};

const makeBotMessage = (id, payload, channel) => ({
  id,
  author: BOT,
  content: payload?.content,
  embeds: payload?.embeds,
  createdTimestamp: Date.now(),
  channel,
});

// Tracks every listener invocation so tests can wait for the bot to go quiet.
const createTracker = () => {
  const entries = new Set();
  const errors = [];
  let started = 0;

  const run = async (entry, listener, args) => {
    try {
      await listener(...args);
    } catch (error) {
      errors.push(error);
    } finally {
      entries.delete(entry);
    }
  };

  const invoke = (listener, args) => {
    const entry = { parked: false };
    started += 1;
    entries.add(entry);
    args.forEach((arg) => arg?.[INVOKED]?.(entry));
    entry.promise = run(entry, listener, args);
    return entry.promise;
  };

  const yieldOnce = () => new Promise((resolve) => setImmediate(resolve));

  // A handler may park itself on a modal only after a few microtasks, so
  // waiting on its promise could deadlock; yield and re-check instead.
  const settle = async () => {
    let quiet = 0;
    while (quiet < 2) {
      const before = started;
      await yieldOnce();
      const busy = [...entries].some((entry) => !entry.parked);
      quiet = busy || started !== before ? 0 : quiet + 1;
    }
  };

  return { invoke, settle, errors };
};

export const createFakeDiscord = () => {
  let counter = 0;
  const nextId = () => `auto-${++counter}`;
  const tracker = createTracker();
  const guild = createGuild();
  const channel = createChannel(CHANNEL_ID, guild, nextId);
  const otherChannel = createChannel(OTHER_CHANNEL_ID, guild, nextId);
  const pendingModals = new Set();
  const state = {
    client: null,
    clientOptions: null,
    guild,
    channel,
    otherChannel,
    loginTokens: [],
    guildFetches: [],
    errors: tracker.errors,
    settle: tracker.settle,
  };

  const makeMessage = ({
    id = nextId(), author = 'alice', content = '', timestamp = Date.now(),
    reference = null, bot = false, channel: target = channel, guild: guildField = target.guild,
  } = {}) => {
    const message = {
      id,
      author: { id: `user-${author}`, username: author, bot },
      content,
      createdTimestamp: timestamp,
      reference: reference ? { messageId: reference } : null,
      channel: target,
      guild: guildField,
      guildId: target.guildId,
      replies: [],
    };
    message.reply = async (payload) => {
      message.replies.push(payload);
      return makeBotMessage(nextId(), payload, target);
    };
    return message;
  };

  const makeInteraction = (overrides = {}) => {
    const interaction = {
      id: nextId(),
      commandName: 'other',
      user: { id: 'user-alice', username: 'alice' },
      replies: [],
      isMessageContextMenuCommand: () => false,
      ...overrides,
    };
    interaction.reply = async (payload) => {
      interaction.replies.push(payload);
      return makeBotMessage(nextId(), payload, channel);
    };
    return interaction;
  };

  const makeModalSubmit = ({ customId, user, author }) => {
    let editError = null;
    const submit = {
      customId,
      user,
      fields: { getStringSelectValues: () => [author] },
      replies: [],
      edits: [],
      failEdits: (error) => {
        editError = error;
      },
    };
    submit.reply = async (payload) => {
      submit.replies.push(payload);
      return makeBotMessage(nextId(), payload, channel);
    };
    submit.editReply = async (payload) => {
      if (editError) throw editError;
      submit.edits.push(payload);
      return makeBotMessage(nextId(), payload, channel);
    };
    return submit;
  };

  const makeReplyCommand = ({ target, user = 'alice' }) => {
    let entry = null;
    let pending = null;
    const release = () => {
      pendingModals.delete(pending);
      pending = null;
      if (entry) entry.parked = false;
    };
    const takePending = () => {
      if (!pending) throw new Error('fake discord: no modal wait is pending');
      const taken = pending;
      release();
      return taken;
    };
    const interaction = makeInteraction({
      commandName: 'reply',
      user: { id: `user-${user}`, username: user },
      targetMessage: target,
      isMessageContextMenuCommand: () => true,
      modal: null,
      modalOptions: null,
      [INVOKED]: (tracked) => {
        entry = tracked;
      },
    });
    interaction.showModal = async (modal) => {
      interaction.modal = modal.toJSON();
    };
    interaction.awaitModalSubmit = (options) => {
      interaction.modalOptions = options;
      if (entry) entry.parked = true;
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, release };
        pendingModals.add(pending);
      });
    };
    interaction.submit = async ({ author, customId = interaction.modal?.custom_id }) => {
      const taken = takePending();
      const submitted = makeModalSubmit({ customId, user: interaction.user, author });
      taken.resolve(submitted);
      await tracker.settle();
      return submitted;
    };
    interaction.timeout = async () => {
      takePending().reject(new Error('fake discord: modal timed out'));
      await tracker.settle();
    };
    return interaction;
  };

  state.makeMessage = makeMessage;
  state.makeInteraction = makeInteraction;
  state.closePending = () => {
    [...pendingModals].forEach((pending) => {
      pending.release();
      pending.reject(new Error('fake discord: closed while waiting for a modal'));
    });
  };

  class Client extends EventEmitter {
    constructor(options) {
      super();
      this.user = { id: 'bot-user', tag: 'deep-pa-text#0000', username: 'deep-pa-text' };
      this.channels = { fetch: async (id) => fetchKnown(id) };
      this.guilds = { fetch: async (id) => recordGuildFetch(id) };
      state.client = this;
      state.clientOptions = options;
    }

    async login(token) {
      state.loginTokens.push(token);
      return token;
    }

    on(event, listener) {
      return super.on(event, (...args) => tracker.invoke(listener, args));
    }

    once(event, listener) {
      return super.once(event, (...args) => tracker.invoke(listener, args));
    }
  }

  const fetchKnown = (id) => {
    const known = [channel, otherChannel].find((c) => c.id === id);
    if (!known) throw new Error(`fake discord: unknown channel ${id}`);
    return known;
  };
  const recordGuildFetch = (id) => {
    state.guildFetches.push(id);
    return guild;
  };

  return { Client, state, makeMessage, makeInteraction, makeReplyCommand };
};
