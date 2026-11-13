import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageCreateHandler } from '../../../../src/bot/handlers/messageCreate.js';
import { toMessageRecord } from '../../../../src/discord/messageRecord.js';
import { loadConfig } from '../../../../src/config.js';
import { createFakeDiscord } from '../../../support/fakes/discord.js';

const setup = ({
  filtered = {}, decision = null, failAt = null, deliveryFailure = null,
  parent = null, chain = null, chainTarget, config = loadConfig({}), previous = null,
} = {}) => {
  const events = [];
  const verdict = decision ?? {
    reply: true, reason: 'accepted', release: () => events.push('release'),
  };
  const logs = { info: [], warn: [], error: [] };
  const step = (name, value) => async (...args) => {
    events.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
    return typeof value === 'function' ? value(...args) : value;
  };
  const deps = {
    config,
    activity: {
      noteHuman: (arg) => events.push(['noteHuman', arg]),
      noteBot: () => {
        events.push('noteBot');
        return () => events.push('undo');
      },
    },
    ingest: {
      recordMessage: async (record, options) => {
        events.push(['ingest', options]);
        if (failAt === 'ingest') throw new Error('ingest failed');
        return { filtered: 'filtered' in filtered ? filtered.filtered : {} };
      },
    },
    messageFilter: {
      filterAnyAuthor: (record) => (events.push('filter'), filtered.target === null ? null : record),
      // Like the real filter, text that is empty once cleaned is not answerable.
      filterForChain: (record) => {
        events.push('filterForChain');
        if (chainTarget !== undefined) return chainTarget;
        return record.content ? record : null;
      },
    },
    botMessageStore: { getById: () => parent },
    messageStore: { getRaw: () => null, previousRaw: (arg) => (events.push(['previousRaw', arg]), previous) },
    botMessageResolver: { resolve: () => null },
    chainBuilder: { build: (target, p) => (events.push(['build', target, p]), chain) },
    client: { user: { id: 'bot-user' } },
    users: [],
    replyPolicy: {
      decide: () => (events.push('decide'), verdict),
      noteReply: (arg) => events.push(['noteReply', arg]),
      noteFailure: () => events.push('noteFailure'),
    },
    personaSelector: { pickReplier: step('pick', 'bob') },
    responder: {
      respond: async (request) => {
        events.push(['respond', request]);
        if (failAt === 'respond') throw new Error('respond failed');
        if (deliveryFailure) throw Object.assign(new Error('send failed'), { stage: 'delivery' });
        request.onDelivered?.();
        return { response: 'raw', messages: [{ id: 'sent' }] };
      },
    },
    logger: { info: (m) => logs.info.push(m), warn: (...a) => logs.warn.push(a), error: (...a) => logs.error.push(a) },
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
  assert.deepEqual(events.map((e) => (e[0] === 'respond' ? 'respond' : e)), [
    ['noteHuman', { timestamp: 4242, author: 'alice' }],
    ['ingest', { repliesToBot: false, tolerateVectorErrors: true }], 'filter', 'decide', 'noteBot', 'pick',
    'respond',
    ['noteReply', { resetMisses: true }], 'noteBot', 'release',
  ]);
  const [, request] = events.find((e) => e[0] === 'respond');
  const { onDelivered, ...rest } = request;
  assert.equal(typeof onDelivered, 'function');
  assert.deepEqual(rest, {
    trigger: 'auto', persona: 'bob', target: record, guild: message.guild, channel: message.channel,
    via: { type: 'reply', message },
  });
  assert.equal(logs.info.length, 1);
  assert.match(logs.info[0], /alice: hello there\n {2}\[filter kept: yes\][\s\S]*\[REPLY\] bob: raw$/);
});

test('noteHuman runs synchronously before the first await', () => {
  const { handler, events, discord } = setup();
  const pending = handler(discord.makeMessage({ timestamp: 7 }));
  assert.deepEqual(events, [['noteHuman', { timestamp: 7, author: 'alice' }], ['ingest', { repliesToBot: false, tolerateVectorErrors: true }]]);
  return pending;
});

test('a delivery failure is logged once, arms the rate limit without a failure cooldown, undoes activity and releases', async () => {
  const { handler, events, logs, discord } = setup({ deliveryFailure: true });
  await handler(discord.makeMessage());
  assert.deepEqual(events.filter((e) => Array.isArray(e) && e[0] === 'noteReply'), [['noteReply', { resetMisses: false }]]);
  assert.equal(events.filter((e) => e === 'noteBot').length, 1);
  assert.equal(events.includes('noteFailure'), false);
  assert.deepEqual(events.slice(-2), ['undo', 'release']);
  assert.equal(logs.error.length, 1);
  assert.match(logs.error[0][0], /^Error processing message \S+ \(.*stage delivery\):$/);
  assert.match(logs.error[0][1].message, /send failed/);
  assert.equal(logs.info.length, 0);
});

test('logs not replyable and neither decides nor claims activity', async () => {
  const { handler, events, logs, discord } = setup({ filtered: { target: null, filtered: null } });
  await handler(discord.makeMessage({ content: 'hi' }));
  assert.deepEqual(events.slice(1), [['ingest', { repliesToBot: false, tolerateVectorErrors: true }], 'filter']);
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

test('generation failure undoes the activity claim, starts the failure cooldown, releases and logs', async () => {
  const { handler, events, logs, discord } = setup({ failAt: 'respond' });
  await handler(discord.makeMessage());
  assert.deepEqual(events.slice(-5).map((e) => (Array.isArray(e) ? e[0] : e)), ['pick', 'respond', 'undo', 'noteFailure', 'release']);
  assert.equal(events.some((e) => Array.isArray(e) && e[0] === 'noteReply'), false);
  assert.equal(logs.error.length, 1);
});

test('persona selection failure is logged, never throws, and counts as a failure', async () => {
  const { handler, events, logs, discord } = setup({ failAt: 'pick' });
  await handler(discord.makeMessage());
  assert.equal(logs.error.length, 1);
  assert.deepEqual(events.slice(-3), ['undo', 'noteFailure', 'release']);
});

test('logs the in-flight and cooldown no-replies without claiming activity', async () => {
  for (const reason of ['in-flight', 'cooldown']) {
    const { handler, events, logs, discord } = setup({ decision: { reply: false, reason } });
    await handler(discord.makeMessage());
    assert.match(logs.info[0], /\[NOREPLY: [a-z -]+\]$/);
    assert.equal(events.includes('noteBot'), false);
  }
});

test('a failure before decide releases nothing and cools nothing down', async () => {
  const { handler, events, discord } = setup({ failAt: 'ingest' });
  await handler(discord.makeMessage());
  assert.equal(events.includes('release') || events.includes('noteFailure'), false);
});

const PARENT = { id: 'p1', persona: 'bob', content: 'earlier', reference: null };
const CHAIN = { persona: 'bob', turns: [], botTurns: 2 };
const replyTo = (discord, extra = {}) => discord.makeMessage({ content: 'why', reference: 'p1', ...extra });
const names = (events) => events.map((e) => (Array.isArray(e) ? e[0] : e));

test('a reply to a bot message is ingested as such, chained, and answered by the same persona', async () => {
  const { handler, events, logs, discord } = setup({ parent: PARENT, chain: CHAIN });
  const message = replyTo(discord);
  await handler(message);
  assert.deepEqual(names(events), ['noteHuman', 'ingest', 'filterForChain', 'build', 'respond', 'noteReply']);
  assert.deepEqual(events[1], ['ingest', { repliesToBot: true, tolerateVectorErrors: true }]);
  const [, request] = events.find((e) => e[0] === 'respond');
  assert.equal(request.trigger, 'chain');
  assert.equal(request.persona, 'bob');
  assert.equal(request.chain, CHAIN);
  assert.deepEqual(request.via, { type: 'reply', message });
  assert.deepEqual(events.find((e) => e[0] === 'noteReply'), ['noteReply', { resetMisses: false }]);
  assert.match(logs.info[0], /\[CHAIN: bob, 2 bot turns\]\n {4}\[REPLY\] bob: raw$/);
});

test('a chain reply never touches the activity tracker or the random policy', async () => {
  const { handler, events, discord } = setup({ parent: PARENT, chain: CHAIN });
  await handler(replyTo(discord));
  assert.equal(events.includes('noteBot'), false);
  assert.equal(events.includes('decide'), false);
  assert.equal(events.includes('pick'), false);
});

test('a chain reply is answered however many bot turns the thread already has', async () => {
  const { handler, events, discord } = setup({ parent: PARENT, chain: { ...CHAIN, botTurns: 40 } });
  await handler(replyTo(discord));
  assert.ok(events.some((e) => e[0] === 'respond'));
});

test('without a chain the message continues through the normal flow', async () => {
  const unknownPersona = setup({ parent: PARENT, chain: null });
  await unknownPersona.handler(replyTo(unknownPersona.discord));
  assert.ok(unknownPersona.events.includes('decide'));
  assert.deepEqual(unknownPersona.events.find((e) => e[0] === 'ingest'), ['ingest', { repliesToBot: true, tolerateVectorErrors: true }]);
  const emptyTarget = setup({ parent: PARENT, chain: CHAIN, chainTarget: null });
  await emptyTarget.handler(replyTo(emptyTarget.discord));
  assert.equal(emptyTarget.events.some((e) => e[0] === 'build'), false);
  assert.ok(emptyTarget.events.includes('decide'));
});

test('a message that does not reply to a bot message never builds a chain', async () => {
  const { handler, events, discord } = setup({ parent: null });
  await handler(replyTo(discord));
  assert.equal(events.includes('filterForChain'), false);
  assert.deepEqual(events.find((e) => e[0] === 'ingest'), ['ingest', { repliesToBot: false, tolerateVectorErrors: true }]);
});

test('a chain delivery failure arms the auto-reply rate limit and is logged', async () => {
  const { handler, events, logs, discord } = setup({ parent: PARENT, chain: CHAIN, deliveryFailure: true });
  await handler(replyTo(discord));
  assert.deepEqual(events.at(-1), ['noteReply', { resetMisses: false }]);
  assert.equal(logs.error.length, 1);
});

test('a chain generation failure notes nothing: no cooldown, no reply slot, no rate limit', async () => {
  const { handler, events, logs, discord } = setup({ parent: PARENT, chain: CHAIN, failAt: 'respond' });
  await handler(replyTo(discord));
  assert.equal(events.includes('noteFailure') || events.includes('release'), false);
  assert.equal(events.some((e) => e[0] === 'noteReply'), false);
  assert.equal(logs.error.length, 1);
});

test('with chains disabled the chain is never built and the normal flow runs', async () => {
  const config = loadConfig({ CHAIN_REPLIES: 'false' });
  const { handler, events, discord } = setup({ parent: PARENT, chain: CHAIN, config });
  await handler(replyTo(discord));
  assert.deepEqual(events.find((e) => e[0] === 'ingest'), ['ingest', { repliesToBot: true, tolerateVectorErrors: true }]);
  assert.equal(events.some((e) => e === 'filterForChain' || e[0] === 'build'), false);
  assert.ok(events.includes('decide'));
});

const PING = '<@bot-user>';

test('a message that pings the bot is answered by the picked replier without a roll', async () => {
  const { handler, events, logs, discord } = setup();
  const message = discord.makeMessage({ content: `${PING} what do we think about this` });
  await handler(message);
  assert.deepEqual(names(events), ['noteHuman', 'ingest', 'filterForChain', 'pick', 'respond', 'noteReply']);
  const [, request] = events.find((e) => e[0] === 'respond');
  assert.equal(request.trigger, 'mention');
  assert.equal(request.persona, 'bob');
  assert.equal(request.target.content, 'what do we think about this');
  assert.deepEqual(request.via, { type: 'reply', message });
  assert.deepEqual(events.at(-1), ['noteReply', { resetMisses: false }]);
  assert.equal(events.includes('decide') || events.includes('noteBot'), false);
  assert.match(logs.info[0], /\[REPLY\] bob: raw$/);
});

test('a bare ping answers the previous message and replies to the ping', async () => {
  const previous = { id: 'p1', author: 'carol', content: 'anyone want food later', timestamp: 5, reference: null, deleted: false };
  const { handler, events, discord } = setup({ previous });
  const message = discord.makeMessage({ content: PING, timestamp: 9 });
  await handler(message);
  assert.deepEqual(events.find((e) => e[0] === 'previousRaw')[1], { before: 9, excludeId: message.id });
  const [, request] = events.find((e) => e[0] === 'respond');
  assert.equal(request.target.id, 'p1');
  assert.deepEqual(request.via, { type: 'reply', message });
});

test('a bare ping in a reply answers the referenced message, fetched when it is not stored', async () => {
  const { handler, events, deps, discord } = setup();
  const stored = { id: 'old', author: 'dave', content: 'the stored older message', timestamp: 1, reference: null, deleted: false };
  deps.messageStore.getRaw = (id) => (id === 'old' ? stored : null);
  await handler(discord.makeMessage({ content: PING, reference: 'old' }));
  assert.equal(events.find((e) => e[0] === 'respond')[1].target.id, 'old');
  assert.equal(events.some((e) => e[0] === 'previousRaw'), false);

  const fetched = setup();
  const older = fetched.discord.state.addHistory({ id: 'h9', author: 'carol', content: 'only on discord so far' });
  await fetched.handler(fetched.discord.makeMessage({ content: PING, reference: older.id }));
  assert.equal(fetched.events.find((e) => e[0] === 'respond')[1].target.id, 'h9');
});

test('a bare ping with nothing to answer is logged and makes no reply or roll', async () => {
  const nothing = setup({ previous: null });
  await nothing.handler(nothing.discord.makeMessage({ content: PING }));
  assert.equal(nothing.events.some((e) => e[0] === 'respond' || e === 'decide' || e === 'pick'), false);
  assert.match(nothing.logs.info[0], /\[MENTION: nothing to reply to\]$/);
  const deleted = setup({ previous: { id: 'p', author: 'carol', content: 'gone now', timestamp: 1, deleted: true } });
  await deleted.handler(deleted.discord.makeMessage({ content: PING }));
  assert.equal(deleted.events.some((e) => e[0] === 'respond'), false);
  const missing = setup();
  await missing.handler(missing.discord.makeMessage({ content: PING, reference: 'not-anywhere' }));
  assert.equal(missing.events.some((e) => e[0] === 'respond'), false);
  assert.ok(missing.logs.warn.length >= 1);
});

test('a reply to a bot message that also pings the bot is a chain reply, once', async () => {
  const { handler, events, discord } = setup({ parent: PARENT, chain: CHAIN });
  await handler(replyTo(discord, { content: `${PING} and another thing` }));
  const responds = events.filter((e) => e[0] === 'respond');
  assert.equal(responds.length, 1);
  assert.equal(responds[0][1].trigger, 'chain');
});

test('with mention replies off a ping goes through the normal flow', async () => {
  const config = loadConfig({ MENTION_REPLIES: 'false' });
  const { handler, events, discord } = setup({ config });
  await handler(discord.makeMessage({ content: `${PING} what do we think about this` }));
  assert.ok(events.includes('decide'));
  assert.equal(events.find((e) => e[0] === 'respond')[1].trigger, 'auto');
});

test('a mention delivery failure arms the auto-reply rate limit; a generation failure notes nothing', async () => {
  const delivery = setup({ deliveryFailure: true });
  await delivery.handler(delivery.discord.makeMessage({ content: `${PING} are you there` }));
  assert.deepEqual(delivery.events.at(-1), ['noteReply', { resetMisses: false }]);
  assert.equal(delivery.logs.error.length, 1);
  const generation = setup({ failAt: 'respond' });
  await generation.handler(generation.discord.makeMessage({ content: `${PING} are you there` }));
  assert.equal(generation.events.some((e) => e[0] === 'noteReply' || e === 'noteFailure'), false);
  assert.match(generation.logs.error[0][0], /Error processing message/);
});
