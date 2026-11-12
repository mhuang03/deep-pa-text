import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  isReplyCommand, refuse, prepare, isAllowed, showModal, awaitSubmit,
} from '../../../../src/bot/handlers/replyCommandPrepare.js';
import { REPLY_COMMAND_NAME } from '../../../../src/discord/commands.js';
import { WRONG_CHANNEL_MESSAGE, NOT_REPLYABLE_MESSAGE } from '../../../../src/discord/replyModal.js';
import { loadConfig } from '../../../../src/config.js';

const config = loadConfig({});
const makeMessage = (overrides = {}) => ({
  id: 'm1', content: 'a replyable message', author: { id: 'u1', username: 'alice', bot: false },
  createdTimestamp: 1000, reference: null, channel: { id: config.discord.channelId }, attachments: new Map(),
  embeds: [], stickers: new Map(), ...overrides,
});
const makeInteraction = (overrides = {}) => {
  const replies = [];
  return {
    replies, id: 'i1', user: { id: 'u9' }, targetMessage: makeMessage(),
    reply: async (payload) => replies.push(payload),
    ...overrides,
  };
};

test('recognises only the message context menu command with the reply name', () => {
  const command = (isMenu, name) => ({ isMessageContextMenuCommand: () => isMenu, commandName: name });
  assert.equal(isReplyCommand(command(true, REPLY_COMMAND_NAME)), true);
  assert.equal(isReplyCommand(command(false, REPLY_COMMAND_NAME)), false);
  assert.equal(isReplyCommand(command(true, 'other')), false);
});

test('refuse replies ephemerally and never allows mentions', async () => {
  const interaction = makeInteraction();
  await refuse(interaction, 'no');
  assert.deepEqual(interaction.replies, [{ content: 'no', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }]);
});

const deps = (overrides = {}) => ({
  config,
  botMessageResolver: { resolve: () => null },
  messageFilter: { filterAnyAuthor: (record) => record },
  commandLimiter: { check: () => ({ allowed: true }) },
  users: [{ username: 'alice' }, { username: 'bob' }],
  logger: { info: () => {} },
  ...overrides,
});

test('prepare returns the target, message, channel and no default author for a human message', async () => {
  const interaction = makeInteraction();
  const prepared = await prepare(deps(), interaction);
  assert.equal(prepared.target.id, 'm1');
  assert.equal(prepared.defaultAuthor, null);
  assert.equal(prepared.channel, interaction.targetMessage.channel);
});

test('prepare attributes a bot message to its persona and defaults the author to it', async () => {
  const resolver = { resolve: () => ({ persona: 'bob', content: 'bot text here' }) };
  const prepared = await prepare(deps({ botMessageResolver: resolver }), makeInteraction());
  assert.equal(prepared.defaultAuthor, 'bob');
  assert.equal(prepared.target.author, 'bob');
  assert.equal(prepared.target.content, 'bot text here');
});

test('prepare refuses a message the filter rejects', async () => {
  const interaction = makeInteraction();
  const result = await prepare(deps({ messageFilter: { filterAnyAuthor: () => null } }), interaction);
  assert.equal(result, undefined);
  assert.equal(interaction.replies[0].content, NOT_REPLYABLE_MESSAGE);
});

test('prepare refuses a target in another channel without naming a channel', async () => {
  const interaction = makeInteraction({ targetMessage: makeMessage({ channel: { id: 'elsewhere' } }) });
  assert.equal(await prepare(deps(), interaction), undefined);
  assert.equal(interaction.replies[0].content, WRONG_CHANNEL_MESSAGE);
  assert.doesNotMatch(WRONG_CHANNEL_MESSAGE, /#/);
});

test('isAllowed passes a free user and refuses a limited one with the matching text', async () => {
  assert.equal(await isAllowed(deps(), makeInteraction()), true);
  const interaction = makeInteraction();
  const limited = deps({ commandLimiter: { check: () => ({ allowed: false, reason: 'cooldown' }) } });
  assert.equal(await isAllowed(limited, interaction), false);
  assert.equal(interaction.replies.length, 1);
});

test('showModal builds a modal for the invocation and returns its id', async () => {
  const shown = [];
  const interaction = makeInteraction({ showModal: async (modal) => shown.push(modal) });
  const prepared = { target: { content: 'text', author: 'alice' }, defaultAuthor: null };
  const modalId = await showModal(deps(), interaction, prepared);
  assert.equal(modalId, 'replyModal:i1');
  assert.equal(shown[0].toJSON().custom_id, modalId);
});

test('awaitSubmit waits for this user and this modal for the configured time', async () => {
  let options;
  const interaction = makeInteraction({ awaitModalSubmit: async (opts) => { options = opts; return { submitted: true }; } });
  const result = await awaitSubmit(deps(), interaction, 'replyModal:i1');
  assert.deepEqual(result, { submitted: true });
  assert.equal(options.time, config.discord.modalTimeoutMs);
  assert.equal(typeof options.filter, 'function');
  assert.equal(options.filter({ customId: 'replyModal:i1', user: { id: 'u9' } }), true);
  assert.equal(options.filter({ customId: 'replyModal:other', user: { id: 'u9' } }), false);
  assert.equal(options.filter({ customId: 'replyModal:i1', user: { id: 'someone-else' } }), false);
});

test('the modal wait follows config.discord.modalTimeoutMs', async () => {
  let time;
  const custom = { ...config, discord: { ...config.discord, modalTimeoutMs: 4321 } };
  const interaction = makeInteraction({ awaitModalSubmit: async (opts) => { time = opts.time; return null; } });
  await awaitSubmit(deps({ config: custom }), interaction, 'id');
  assert.equal(time, 4321);
});

test('a timeout yields null and is logged; any other failure propagates', async () => {
  const logs = [];
  const timeout = makeInteraction({ awaitModalSubmit: async () => { throw Object.assign(new Error('t'), { code: 'InteractionCollectorError' }); } });
  assert.equal(await awaitSubmit(deps({ logger: { info: (m) => logs.push(m) } }), timeout, 'id'), null);
  assert.equal(logs.length, 1);
  const broken = makeInteraction({ awaitModalSubmit: async () => { throw new Error('network'); } });
  await assert.rejects(awaitSubmit(deps(), broken, 'id'), /network/);
});
