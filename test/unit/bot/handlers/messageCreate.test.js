import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageCreateHandler } from '../../../../src/bot/handlers/messageCreate.js';
import { loadConfig } from '../../../../src/config.js';
import { createFakeDiscord } from '../../../support/fakes/discord.js';

const setup = ({ filtered = {}, decision = { reply: true, reason: 'accepted' }, failAt = null } = {}) => {
  const events = [];
  const logs = { info: [], error: [] };
  const step = (name, value) => async (...args) => {
    events.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
    return typeof value === 'function' ? value(...args) : value;
  };
  const deps = {
    config: loadConfig({}),
    activity: {
      noteHuman: (arg) => events.push(['noteHuman', arg]),
      noteBot: () => events.push('noteBot'),
    },
    ingest: { recordMessage: step('ingest', { filtered: 'filtered' in filtered ? filtered.filtered : {} }) },
    messageFilter: { filterAnyAuthor: (record) => (events.push('filter'), filtered.target === null ? null : record) },
    replyPolicy: {
      decide: () => (events.push('decide'), decision),
      noteReply: (arg) => events.push(['noteReply', arg]),
    },
    personaSelector: { pickReplier: step('pick', 'bob') },
    composer: { composeReply: step('compose', { response: 'raw', payload: { content: 'c', embeds: [] } }) },
    logger: { info: (m) => logs.info.push(m), error: (...a) => logs.error.push(a) },
  };
  const discord = createFakeDiscord();
  return { handler: createMessageCreateHandler(deps), deps, events, logs, discord };
};

test('ignores messages from other channels and from bots', async () => {
  const { handler, events, discord } = setup();
  await handler(discord.makeMessage({ channel: discord.state.otherChannel }));
  await handler(discord.makeMessage({ bot: true }));
  assert.deepEqual(events, []);
});

test('replies in order: human noted before ingest, bot claimed before generation', async () => {
  const { handler, events, logs, discord } = setup();
  const message = discord.makeMessage({ content: 'hello there', timestamp: 4242 });
  await handler(message);
  assert.deepEqual(events, [
    ['noteHuman', { timestamp: 4242, author: 'alice' }],
    'ingest', 'filter', 'decide', 'noteBot', 'pick', 'compose',
    ['noteReply', { resetMisses: true }], 'noteBot',
  ]);
  assert.deepEqual(message.replies, [{ content: 'c', embeds: [] }]);
  assert.equal(logs.info.length, 1);
  assert.match(logs.info[0], /alice: hello there\n {2}\[filter kept: yes\][\s\S]*\[REPLY\] bob: raw$/);
});

test('noteHuman runs synchronously before the first await', () => {
  const { handler, events, discord } = setup();
  const pending = handler(discord.makeMessage({ timestamp: 7 }));
  assert.deepEqual(events, [['noteHuman', { timestamp: 7, author: 'alice' }], 'ingest']);
  return pending;
});

test('does not await message.reply and logs a rejected send', async () => {
  const { handler, events, logs, discord } = setup();
  let rejectSend;
  const message = discord.makeMessage();
  message.reply = () => new Promise((_, reject) => { rejectSend = reject; });
  await handler(message);
  assert.equal(events.at(-1), 'noteBot');
  assert.equal(logs.error.length, 0);
  rejectSend(new Error('send failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.error.length, 1);
  assert.match(logs.error[0][1].message, /send failed/);
});

test('logs not replyable and neither decides nor claims activity', async () => {
  const { handler, events, logs, discord } = setup({ filtered: { target: null, filtered: null } });
  await handler(discord.makeMessage({ content: 'hi' }));
  assert.deepEqual(events.slice(1), ['ingest', 'filter']);
  assert.match(logs.info[0], /filter kept: no[\s\S]*\[NOREPLY: not replyable\]$/);
});

test('logs a rate-limited and a random no-reply and stops', async () => {
  const limited = setup({ decision: { reply: false, reason: 'rate-limited' } });
  await limited.handler(limited.discord.makeMessage());
  assert.match(limited.logs.info[0], /\[NOREPLY: rate limited\]$/);
  const random = setup({ decision: { reply: false, reason: 'random', roll: 0.5, chance: 0.1 } });
  await random.handler(random.discord.makeMessage());
  assert.match(random.logs.info[0], /\[NOREPLY: random 0.50 > 0.1\]$/);
  assert.equal(random.events.includes('noteBot'), false);
});

test('ingest failure is logged, nothing else runs, and the human stays noted', async () => {
  const { handler, events, logs, discord } = setup({ failAt: 'ingest' });
  await handler(discord.makeMessage());
  assert.deepEqual(events.map((e) => (Array.isArray(e) ? e[0] : e)), ['noteHuman', 'ingest']);
  assert.equal(logs.error.length, 1);
});

test('generation failure keeps the bot claim, arms no rate limit and logs', async () => {
  const { handler, events, logs, discord } = setup({ failAt: 'compose' });
  const message = discord.makeMessage();
  await handler(message);
  assert.deepEqual(events.slice(-3), ['noteBot', 'pick', 'compose']);
  assert.equal(events.some((e) => Array.isArray(e) && e[0] === 'noteReply'), false);
  assert.deepEqual(message.replies, []);
  assert.equal(logs.error.length, 1);
});

test('persona selection failure is logged and never throws', async () => {
  const { handler, logs, discord } = setup({ failAt: 'pick' });
  await handler(discord.makeMessage());
  assert.equal(logs.error.length, 1);
});
