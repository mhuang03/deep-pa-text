import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageCreateHandler } from '../../../../src/bot/handlers/messageCreate.js';
import { toMessageRecord } from '../../../../src/discord/messageRecord.js';
import { loadConfig } from '../../../../src/config.js';
import { createFakeDiscord } from '../../../support/fakes/discord.js';

const setup = ({
  filtered = {}, decision = { reply: true, reason: 'accepted' }, failAt = null, deliveryFailure = null,
} = {}) => {
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
    responder: {
      respond: async (request) => {
        events.push(['respond', request]);
        if (failAt === 'respond') throw new Error('respond failed');
        if (deliveryFailure) throw Object.assign(new Error('send failed'), { stage: 'delivery' });
        return { response: 'raw', message: { id: 'sent' } };
      },
    },
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
  const record = toMessageRecord(message);
  await handler(message);
  assert.deepEqual(events, [
    ['noteHuman', { timestamp: 4242, author: 'alice' }],
    'ingest', 'filter', 'decide', 'noteBot', 'pick',
    ['respond', {
      trigger: 'auto', persona: 'bob', target: record, guild: message.guild, channel: message.channel,
      via: { type: 'reply', message },
    }],
    ['noteReply', { resetMisses: true }], 'noteBot',
  ]);
  assert.equal(logs.info.length, 1);
  assert.match(logs.info[0], /alice: hello there\n {2}\[filter kept: yes\][\s\S]*\[REPLY\] bob: raw$/);
});

test('noteHuman runs synchronously before the first await', () => {
  const { handler, events, discord } = setup();
  const pending = handler(discord.makeMessage({ timestamp: 7 }));
  assert.deepEqual(events, [['noteHuman', { timestamp: 7, author: 'alice' }], 'ingest']);
  return pending;
});

test('a delivery failure is logged once, arms the rate limit without resetting misses, and keeps the claim', async () => {
  const { handler, events, logs, discord } = setup({ deliveryFailure: true });
  await handler(discord.makeMessage());
  assert.deepEqual(events.filter((e) => Array.isArray(e) && e[0] === 'noteReply'), [['noteReply', { resetMisses: false }]]);
  assert.equal(events.filter((e) => e === 'noteBot').length, 1);
  assert.equal(logs.error.length, 1);
  assert.match(logs.error[0][1].message, /send failed/);
  assert.equal(logs.info.length, 0);
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
  const { handler, events, logs, discord } = setup({ failAt: 'respond' });
  await handler(discord.makeMessage());
  assert.deepEqual(events.slice(-3).map((e) => (Array.isArray(e) ? e[0] : e)), ['noteBot', 'pick', 'respond']);
  assert.equal(events.some((e) => Array.isArray(e) && e[0] === 'noteReply'), false);
  assert.equal(logs.error.length, 1);
});

test('persona selection failure is logged and never throws', async () => {
  const { handler, logs, discord } = setup({ failAt: 'pick' });
  await handler(discord.makeMessage());
  assert.equal(logs.error.length, 1);
});
