import { EventEmitter } from 'node:events';
import { runInEntry } from './parking.js';
import { createMembers } from './members.js';
import { attachWebhooks } from './webhooks.js';
import { CHANNEL_ID, GUILD_ID, OTHER_CHANNEL_ID } from '../fixtures.js';

// Interactions that define this symbol are told which tracked handler run they belong to.
export const INVOKED = Symbol('fake-discord-invoked');

const BOT = { id: 'bot-user', bot: true };

const createGuild = () => ({ id: GUILD_ID, members: createMembers() });

// One-shot by default: the next `times` calls of the guarded method reject with `error`.
const createFailer = () => {
  let error = null;
  let left = 0;
  return {
    arm: (failure, { times = 1 } = {}) => {
      error = failure;
      left = times;
    },
    check: () => {
      if (left <= 0) return;
      left -= 1;
      throw error;
    },
  };
};

// Mirrors discord.js: a Collection (here a Map) ordered newest first.
const createMessages = (history) => {
  let failure = null;
  const messages = {
    calls: [],
    setFailing: (error) => {
      failure = error ?? null;
    },
    async fetch({ limit, before } = {}) {
      messages.calls.push({ limit, before });
      if (failure) throw failure;
      const index = history.findIndex((message) => message.id === before);
      const preceding = index === -1 ? history : history.slice(0, index);
      return new Map(preceding.slice(-limit).reverse().map((message) => [message.id, message]));
    },
  };
  return messages;
};

const createChannel = (id, guild, nextId) => {
  const channel = {
    id, guild, guildId: guild.id, sent: [], sentMessages: [], history: [], typingCalls: 0,
  };
  channel.messages = createMessages(channel.history);
  const failer = createFailer();
  channel.failSends = failer.arm;
  const typingFailer = createFailer();
  channel.failTyping = typingFailer.arm;
  channel.sendTyping = async () => {
    channel.typingCalls += 1;
    typingFailer.check();
  };
  channel.send = async (payload) => {
    failer.check();
    channel.sent.push(payload);
    const message = makeBotMessage(nextId(), payload, channel);
    channel.sentMessages.push(message);
    return message;
  };
  attachWebhooks(channel, nextId);
  return channel;
};

const makeBotMessage = (id, payload, channel, reference = null) => {
  const message = {
    id,
    author: BOT,
    content: payload?.content,
    embeds: payload?.embeds,
    reference,
    createdTimestamp: Date.now(),
    channel,
    channelId: channel.id,
    url: `https://discord.test/channels/${channel.guildId}/${channel.id}/${id}`,
  };
  channel.history.push(message);
  return message;
};

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
    entry.promise = runInEntry(entry, () => run(entry, listener, args));
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
  const pendingWaits = [];
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
      editedTimestamp: null,
      partial: false,
      reference: reference ? { messageId: reference } : null,
      channel: target,
      channelId: target.id,
      guild: guildField,
      guildId: target.guildId,
      replies: [],
      referenceFetches: 0,
      url: `https://discord.test/channels/${target.guildId}/${target.id}/${id}`,
    };
    message.fetch = async () => message;
    // Resolves to the history message with the referenced id, like discord.js; rejects when it is gone.
    message.fetchReference = async () => {
      message.referenceFetches += 1;
      const found = target.history.find((m) => m.id === reference);
      if (!found) throw new Error(`fake discord: referenced message ${reference} not found`);
      return found;
    };
    const failer = createFailer();
    message.failReplies = failer.arm;
    message.reply = async (payload) => {
      failer.check();
      message.replies.push(payload);
      return makeBotMessage(nextId(), payload, target, { messageId: id });
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
    const replyFailer = createFailer();
    const editFailer = createFailer();
    const followUpFailer = createFailer();
    const submit = {
      customId,
      user,
      fields: { getStringSelectValues: () => [author] },
      replies: [],
      edits: [],
      followUps: [],
      failFollowUps: followUpFailer.arm,
      failReply: replyFailer.arm,
      failEdits: editFailer.arm,
    };
    submit.reply = async (payload) => {
      replyFailer.check();
      submit.replies.push(payload);
      return makeBotMessage(nextId(), payload, channel);
    };
    submit.editReply = async (payload) => {
      editFailer.check();
      submit.edits.push(payload);
      return makeBotMessage(nextId(), payload, channel);
    };
    submit.followUp = async (payload) => {
      followUpFailer.check();
      submit.followUps.push(payload);
      return makeBotMessage(nextId(), payload, channel);
    };
    return submit;
  };

  const TIMEOUT_MESSAGE = 'Collector received no interactions before ending with reason: time';

  const makeReplyCommand = ({ target, user = 'alice' }) => {
    let entry = null;
    let own = null;
    const release = (wait) => {
      pendingWaits.splice(pendingWaits.indexOf(wait), 1);
      if (own === wait) own = null;
      if (entry) entry.parked = false;
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
      if (typeof options?.time !== 'number') {
        throw new TypeError('fake discord: awaitModalSubmit requires a numeric time');
      }
      interaction.modalOptions = options;
      if (entry) entry.parked = true;
      return new Promise((resolve, reject) => {
        const wait = { filter: options.filter, resolve, reject, release: () => release(wait) };
        own = wait;
        pendingWaits.push(wait);
      });
    };
    // `failReply` / `failEdits` are `{ error, times }` and arm the submission before any handler sees it.
    interaction.submit = async ({
      author, customId = interaction.modal?.custom_id, user: submitter = interaction.user,
      failReply = null, failEdits = null,
    }) => {
      const submitted = makeModalSubmit({ customId, user: submitter, author });
      if (failReply) submitted.failReply(failReply.error, failReply);
      if (failEdits) submitted.failEdits(failEdits.error, failEdits);
      [...pendingWaits]
        .filter((wait) => !wait.filter || wait.filter(submitted))
        .forEach((wait) => {
          wait.release();
          wait.resolve(submitted);
        });
      await tracker.settle();
      return submitted;
    };
    interaction.timeout = async () => {
      if (!own) throw new Error('fake discord: no modal wait is pending');
      const wait = own;
      wait.release();
      wait.reject(Object.assign(new Error(TIMEOUT_MESSAGE), { code: 'InteractionCollectorError' }));
      await tracker.settle();
    };
    return interaction;
  };

  state.makeMessage = makeMessage;
  state.addHistory = (fields) => {
    const message = makeMessage(fields);
    message.channel.history.push(message);
    return message;
  };
  // A deleted or uncached message arrives as an id and a channel id only.
  const findMessage = (id) => [channel, otherChannel].flatMap((c) => c.history).find((m) => m.id === id);
  state.partialOf = (messageOrId) => {
    const id = typeof messageOrId === 'string' ? messageOrId : messageOrId.id;
    const known = findMessage(id);
    const channelId = (known ?? messageOrId).channelId ?? channel.id;
    const owner = [channel, otherChannel].find((c) => c.id === channelId) ?? channel;
    const index = owner.history.findIndex((m) => m.id === id);
    if (index !== -1) owner.history.splice(index, 1);
    return { id, channelId, partial: true };
  };
  // Updates the stored message in place, like a cache refresh, and returns the old and new views.
  state.applyEdit = (message, { content, editedTimestamp, partial }) => {
    const oldMessage = { ...message };
    message.content = content;
    message.editedTimestamp = editedTimestamp;
    if (!partial) return { oldMessage, newMessage: message };
    const stub = { id: message.id, channelId: message.channelId, partial: true, fetch: async () => message };
    return { oldMessage: { id: message.id, channelId: message.channelId, partial: true }, newMessage: stub };
  };
  state.makeInteraction = makeInteraction;
  state.closePending = () => {
    [...pendingWaits].forEach((pending) => {
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
