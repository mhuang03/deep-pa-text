import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationPlanner } from '../../../../src/bot/conversation/conversationPlanner.js';
import { loadConfig } from '../../../../src/config.js';

const NOW = Date.parse('2026-11-12T18:00:00Z');
const CHANNEL = { id: 'channel' };

const author = (name, share = 0.25) => ({ author: name, share, newestTimestamp: NOW });
const candidate = (extra = {}) => ({
  topicId: 4,
  label: 'Camping trips',
  summary: 'People plan trips.',
  authors: [author('alice'), author('bob'), author('carol'), author('dave')],
  samples: [{ author: 'alice', text: 'pack the tent' }],
  ...extra,
});

const ANSWER = JSON.stringify({ choice: 1, topic: 'Camping soon', premise: 'Someone floats a trip.' });

const setup = ({
  candidates = [candidate()], recent = [], rolls = [], answers = [ANSWER], context = { transcript: [], quietMs: 60000 },
  openers = [], conversation = {}, hits = [], contextFails = false,
} = {}) => {
  const log = { candidates: [], openers: [], completes: [], inserts: [], queries: [], warnings: [] };
  const used = [];
  const queue = [...answers];
  const config = loadConfig({});
  const planner = createConversationPlanner({
    topicSource: {
      candidates: async (arg) => (log.candidates.push(arg), candidates),
      openers: (arg) => (log.openers.push(arg), openers),
    },
    conversationStore: {
      recent: (arg) => (log.recent = arg, recent),
      insert: (plan, at) => log.inserts.push([plan, at]),
    },
    contextBuilder: {
      forRevive: async (arg) => {
        log.context = arg;
        if (contextFails) throw new Error('history down');
        return context;
      },
    },
    chatClient: {
      complete: async (request) => {
        log.completes.push(request);
        return queue.length > 1 ? queue.shift() : queue[0];
      },
    },
    vectorStore: { query: async (...args) => (log.queries.push(args), hits) },
    messageStore: { hiddenIds: () => new Set() },
    userDirectory: { usernames: new Set(['alice', 'bob', 'carol', 'dave', 'erin']) },
    random: () => {
      used.push(rolls[used.length] ?? 0);
      return used.at(-1);
    },
    clock: { now: () => NOW },
    config: { ...config, conversation: { ...config.conversation, ...conversation } },
    logger: { warn: (...args) => log.warnings.push(args) },
  });
  return { planner, log, used };
};

test('asks for candidates excluding the topic ids of recent conversations and builds the stored plan', async () => {
  const { planner, log } = setup({
    recent: [{ id: 'c0', topicId: 9, topic: 'Old' }, { id: 'c00', topicId: null, topic: 'Unbanked' }, { id: 'c000', topicId: 3, topic: 'Older' }],
    rolls: [0, 0, 0, 0, 0, 0, 0, 0],
  });
  const plan = await planner.plan({ channel: CHANNEL });
  assert.deepEqual(log.recent, { limit: 10 });
  assert.deepEqual(log.candidates, [{ limit: 5, excludeTopicIds: [9, 3] }]);
  assert.deepEqual(log.openers, [{ limit: 6 }]);
  assert.deepEqual(log.context, { channel: CHANNEL, nowMs: NOW });
  assert.equal(plan.id, 'c20261112180000');
  assert.equal(plan.topicId, 4);
  assert.equal(plan.topic, 'Camping soon');
  assert.equal(plan.premise, 'Someone floats a trip.');
  assert.deepEqual(plan.situation, { nowMs: NOW, quietMs: 60000 });
  assert.deepEqual(log.inserts, [[plan, NOW]]);
  assert.match(log.completes[0].user, /These topics were used recently\. Do not choose them again:\n\["Old","Unbanked","Older"\]/);
});

test('the rolls run in the specified order: persona count, one per persona drawn, message count, then the turn order', async () => {
  // count roll 0.5 -> 2 + floor(0.5 * 4) = 4 personas; 4 draws; message roll 0.99 -> 6 messages.
  const { planner, used } = setup({ rolls: [0.5, 0, 0, 0, 0, 0.99] });
  const plan = await planner.plan({ channel: CHANNEL });
  assert.equal(plan.personas.length, 4);
  assert.equal(plan.turns.length, 6);
  assert.ok(used.length >= 6 + 2, 'turn planning rolls follow the message count');
  assert.deepEqual(used.slice(0, 6), [0.5, 0, 0, 0, 0, 0.99]);
});

test('the personas are drawn from the chosen candidate, not from the other candidates', async () => {
  const other = candidate({ topicId: 5, authors: [author('erin', 1)] });
  const { planner } = setup({ candidates: [candidate(), other], answers: [ANSWER] });
  const plan = await planner.plan({ channel: CHANNEL });
  assert.ok(plan.personas.every((name) => name !== 'erin'));
});

test('the choice names the candidate: choice 2 uses the second candidate and its topic id', async () => {
  const second = candidate({ topicId: null, label: null, summary: null, authors: [author('erin', 0.5), author('bob', 0.5)] });
  const answer = JSON.stringify({ choice: 2, topic: 'Neighbourhood chat', premise: 'p' });
  const { planner } = setup({ candidates: [candidate(), second], answers: [answer], rolls: [0, 0, 0, 0, 0, 0] });
  const plan = await planner.plan({ channel: CHANNEL });
  assert.equal(plan.topicId, null);
  assert.deepEqual([...plan.personas].sort(), ['bob', 'erin']);
});

test('every persona speaks, the turns match the plan length and the same persona never speaks twice in a row', async () => {
  const { planner } = setup({ rolls: [0.99, 0.1, 0.2, 0.3, 0.4, 0.5, 0.99, 0.2, 0.9, 0.4, 0.6, 0.1] });
  const plan = await planner.plan({ channel: CHANNEL });
  assert.equal(plan.personas.length, 4, 'only four authors exist on the topic and the history adds none');
  plan.personas.forEach((name) => assert.ok(plan.turns.includes(name)));
  plan.turns.forEach((name, i) => assert.notEqual(name, plan.turns[i - 1]));
});

test('with only two users the conversation has exactly two personas, strictly alternating', async () => {
  const two = candidate({ authors: [author('alice', 0.5), author('bob', 0.5)] });
  const { planner } = setup({ candidates: [two], rolls: [0.99, 0, 0, 0.99] });
  const plan = await planner.plan({ channel: CHANNEL });
  assert.equal(plan.personas.length, 2);
  assert.equal(plan.turns.length, 6);
  plan.turns.forEach((name, i) => assert.equal(name, plan.turns[i % 2]));
});

test('the message count is at least the number of personas', async () => {
  // minMessages 3 but five personas are wanted: raise the floor via config to see max(minMessages, personas).
  const { planner } = setup({
    candidates: [candidate({ authors: ['alice', 'bob', 'carol', 'dave', 'erin'].map((n) => author(n, 0.2)) })],
    rolls: [0.99, 0, 0, 0, 0, 0, 0],
    conversation: { minMessages: 1, maxMessages: 5 },
  });
  const plan = await planner.plan({ channel: CHANNEL });
  assert.equal(plan.personas.length, 5);
  assert.equal(plan.turns.length, 5);
});

test('no candidates fails with no-topics, without a topic call or a stored row', async () => {
  const { planner, log } = setup({ candidates: [] });
  assert.deepEqual(await planner.plan({ channel: CHANNEL }), { failed: 'no-topics' });
  assert.deepEqual([log.completes, log.inserts, log.openers], [[], [], []]);
});

test('an invalid answer twice fails with topic-call, and a stored row is not written', async () => {
  const { planner, log } = setup({ answers: ['prose only'] });
  assert.deepEqual(await planner.plan({ channel: CHANNEL }), { failed: 'topic-call' });
  assert.equal(log.completes.length, 2);
  assert.deepEqual(log.inserts, []);
});

test('a choice out of range counts as invalid', async () => {
  const { planner } = setup({ answers: [JSON.stringify({ choice: 2, topic: 't', premise: 'p' })] });
  assert.deepEqual(await planner.plan({ channel: CHANNEL }), { failed: 'topic-call' });
});

test('a chosen topic with one author is topped up from the history', async () => {
  const solo = candidate({ authors: [author('alice', 1)] });
  const hits = [
    { id: 'h1', distance: 0, metadata: { author: 'bob', timestamp: NOW } },
    { id: 'h2', distance: 0, metadata: { author: 'carol', timestamp: NOW } },
  ];
  const { planner, log } = setup({ candidates: [solo], hits, rolls: [0, 0, 0, 0] });
  const plan = await planner.plan({ channel: CHANNEL });
  assert.deepEqual(log.queries, [['messages', { text: 'Camping soon. Someone floats a trip.', limit: 60 }]]);
  assert.equal(plan.personas[0], 'alice');
  assert.ok(plan.personas.length >= 2);
});

test('nobody else found means too-few-personas, with nothing stored', async () => {
  const solo = candidate({ authors: [author('alice', 1)] });
  const { planner, log } = setup({ candidates: [solo], hits: [] });
  assert.deepEqual(await planner.plan({ channel: CHANNEL }), { failed: 'too-few-personas' });
  assert.deepEqual(log.inserts, []);
});

test('a failure to build the revive context degrades to no transcript and the plan goes ahead', async () => {
  const { planner, log } = setup({ contextFails: true });
  const plan = await planner.plan({ channel: CHANNEL });
  assert.deepEqual(plan.situation, { nowMs: NOW, quietMs: null });
  assert.equal(log.warnings.length, 1);
  assert.ok(!log.completes[0].user.includes('last conversation'));
});

test('the opener samples and the recent-topic limit come from the configuration', async () => {
  const { planner, log } = setup({ conversation: { openerSamples: 0, avoidRecentTopics: 0, topicCandidates: 2 } });
  await planner.plan({ channel: CHANNEL });
  assert.deepEqual(log.recent, { limit: 0 });
  assert.deepEqual(log.openers, [{ limit: 0 }]);
  assert.deepEqual(log.candidates, [{ limit: 2, excludeTopicIds: [] }]);
});

test('openers appear in the topic prompt when there are some', async () => {
  const { planner, log } = setup({ openers: [{ author: 'dave', text: 'anyone up for a game' }] });
  await planner.plan({ channel: CHANNEL });
  assert.match(log.completes[0].user, /Messages that have restarted this chat after a quiet spell:\n\[\{"author":"dave"/);
});
