import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationRunner } from '../../../../src/bot/conversation/conversationRunner.js';
import { loadConfig } from '../../../../src/config.js';

const START = 1_000_000;
const CHANNEL = { id: 'channel' };
const GUILD = { id: 'guild' };
const SITUATION = { nowMs: START, quietMs: 5000 };

const plan = (turns = ['alice', 'bob', 'alice', 'bob']) => ({
  id: 'c1', topicId: 2, topic: 'Weekend plans', premise: 'A hike is floated.', personas: ['alice', 'bob'], turns,
  situation: SITUATION,
});

// `act(request, index)` runs while a turn is being generated; it may advance the clock or throw.
const setup = ({ rolls = [], act = null, shuttingDown = () => false, parts = null, stamped = true } = {}) => {
  const time = { now: START };
  const log = { requests: [], sleeps: [], errors: [], noteBot: 0, noteReply: [], first: 0, delivered: [] };
  const used = [];
  let sent = 0;
  const responder = {
    respond: async (request) => {
      const index = log.requests.length;
      log.requests.push(request);
      if (act) await act(request, index, time);
      await request.beforeDeliver?.();
      const texts = parts?.[index] ?? [`message ${index}`];
      request.onDelivered();
      const delivered = texts.map((text) => ({
        message: stamped ? { id: `m${sent += 1}`, createdTimestamp: time.now } : { id: `m${sent += 1}` }, text,
      }));
      log.delivered.push(delivered);
      return { response: texts.join('\n'), messages: delivered.map((d) => d.message), delivered };
    },
  };
  const runner = createConversationRunner({
    responder,
    replyPolicy: { noteReply: (arg) => log.noteReply.push(arg) },
    activity: { noteBot: () => { log.noteBot += 1; } },
    lifecycle: { isShuttingDown: () => shuttingDown(log) },
    random: () => {
      used.push(rolls[used.length] ?? 0);
      return used.at(-1);
    },
    clock: { now: () => time.now, sleep: async (ms) => { log.sleeps.push(ms); time.now += ms; } },
    config: loadConfig({}),
    logger: { error: (...args) => log.errors.push(args) },
  });
  const run = (options = {}) => runner.run({
    plan: plan(), channel: CHANNEL, guild: GUILD, onFirstDelivered: () => { log.first += 1; }, ...options,
  });
  return { run, log, time, used };
};

test('plays every planned turn in order and resolves with the delivered count', async () => {
  const { run, log } = setup();
  assert.deepEqual(await run(), { delivered: 4 });
  assert.deepEqual(log.requests.map((r) => r.persona), ['alice', 'bob', 'alice', 'bob']);
});

test('each request carries the trigger, destination and conversation context', async () => {
  const { run, log } = setup();
  await run();
  const [opener, second, , last] = log.requests;
  assert.equal(opener.trigger, 'conversation');
  assert.deepEqual([opener.guild, opener.channel, opener.via], [GUILD, CHANNEL, { type: 'channel', channel: CHANNEL }]);
  assert.equal(opener.target, null);
  assert.equal(opener.beforeDeliver, undefined, 'the opener waits for nothing');
  assert.deepEqual(opener.conversation, {
    id: 'c1', topic: 'Weekend plans', premise: 'A hike is floated.', participants: ['alice', 'bob'], turns: [],
    turnIndex: 0, remaining: 3, isLast: false, situation: SITUATION,
  });
  assert.equal(typeof second.beforeDeliver, 'function');
  assert.equal(second.conversation.turnIndex, 1);
  assert.equal(last.conversation.isLast, true);
  assert.equal(last.conversation.remaining, 0);
});

test('a later turn targets the previous turn and its context lists the turns delivered so far', async () => {
  const { run, log } = setup();
  await run();
  assert.deepEqual(log.requests[1].target, { id: 'm1', author: 'alice', content: 'message 0', timestamp: START });
  assert.deepEqual(log.requests[1].conversation.turns, [{ speaker: 'alice', content: 'message 0', timestamp: START }]);
  assert.deepEqual(log.requests[3].target, { id: 'm3', author: 'alice', content: 'message 2', timestamp: log.requests[3].target.timestamp });
  assert.deepEqual(log.requests[3].conversation.turns.map((t) => [t.speaker, t.content]), [
    ['alice', 'message 0'], ['bob', 'message 1'], ['alice', 'message 2'],
  ]);
});

test('earlier requests do not see turns added later', async () => {
  const { run, log } = setup();
  await run();
  assert.equal(log.requests[1].conversation.turns.length, 1);
});

test('a burst turn is one turn: its texts joined by a newline, the next turn targeting its first message', async () => {
  const { run, log } = setup({ parts: { 1: ['first part', 'second part'] } });
  await run();
  assert.deepEqual(log.requests[2].target, {
    id: 'm2', author: 'bob', content: 'first part\nsecond part', timestamp: log.requests[2].target.timestamp,
  });
  assert.equal(log.requests[2].conversation.turns[1].content, 'first part\nsecond part');
  assert.equal(log.requests.length, 4, 'the burst did not add a turn');
});

test('a turn whose message has no timestamp takes the clock time at delivery', async () => {
  const { run, log } = setup({ stamped: false, rolls: [0] });
  await run();
  assert.deepEqual(log.requests[1].target.timestamp, START);
  assert.deepEqual(log.requests[2].target.timestamp, START + 5000);
});

test('the delay for a later turn is drawn after the previous turn, within the bounds, and is slept in full', async () => {
  // delay = 5000 + floor(roll * 25001): 0 -> 5000, 0.5 -> 17500, 0.99999 -> 30000.
  const { run, log, used } = setup({ rolls: [0, 0.5, 0.99999] });
  await run();
  assert.deepEqual(log.sleeps, [5000, 17500, 30000]);
  assert.equal(used.length, 3, 'one roll per turn after the opener, none for the opener');
});

test('generation that takes longer than the delay is sent at once with no extra wait', async () => {
  const { run, log } = setup({ rolls: [0], act: async (request, index, time) => { if (index === 1) time.now += 8000; } });
  await run();
  assert.deepEqual(log.sleeps, [5000, 5000], 'turn 1 waited for nothing; turns 2 and 3 slept their full delay');
});

test('only the remainder of the delay is slept when generation took part of it', async () => {
  const { run, log } = setup({ rolls: [0], act: async (request, index, time) => { if (index === 1) time.now += 3000; } });
  await run();
  assert.deepEqual(log.sleeps, [2000, 5000, 5000]);
});

test('each delivered turn notes the bot as the last speaker and a reply without resetting misses', async () => {
  const { run, log } = setup();
  await run();
  assert.equal(log.noteBot, 4);
  assert.deepEqual(log.noteReply, Array(4).fill({ resetMisses: false }));
});

test('onFirstDelivered fires once, for the first turn only', async () => {
  const { run, log } = setup();
  await run();
  assert.equal(log.first, 1);
});

test('a failure after at least one turn is logged, ends the conversation and resolves', async () => {
  const { run, log } = setup({
    act: async (request, index) => {
      if (index === 2) throw Object.assign(new Error('llm down'), { stage: 'generation' });
    },
  });
  assert.deepEqual(await run(), { delivered: 2 });
  assert.equal(log.requests.length, 3);
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0][0], /Conversation c1 ended after 2 of 4 turns \(conversation turn as alice, stage generation\):/);
  assert.equal(log.errors[0][1].message, 'llm down');
});

test('a failure of the opener rejects with that error and nothing is marked delivered', async () => {
  const error = new Error('opener failed');
  const { run, log } = setup({ act: async () => { throw error; } });
  await assert.rejects(run(), (thrown) => thrown === error);
  assert.deepEqual([log.first, log.noteBot, log.errors], [0, 0, []]);
});

test('a turn that delivers nothing is a failure', async () => {
  const { run } = setup({ parts: { 0: [] } });
  await assert.rejects(run(), /delivered no message/);
});

test('shutting down before a turn stops the conversation quietly', async () => {
  const { run, log } = setup({ shuttingDown: (state) => state.delivered.length >= 2 });
  assert.deepEqual(await run(), { delivered: 2 });
  assert.deepEqual(log.errors, []);
  assert.equal(log.requests.length, 2);
});

test('shutting down before the opener plays nothing', async () => {
  const { run, log } = setup({ shuttingDown: () => true });
  assert.deepEqual(await run(), { delivered: 0 });
  assert.equal(log.requests.length, 0);
});

test('shutting down during the wait before a turn aborts it quietly: no log, no further turns', async () => {
  const { run, log } = setup({ rolls: [0], shuttingDown: (state) => state.sleeps.length >= 1 });
  assert.deepEqual(await run(), { delivered: 1 });
  assert.deepEqual(log.errors, []);
  assert.equal(log.requests.length, 2, 'the second turn was generated but never sent');
  assert.equal(log.delivered.length, 1);
});

test('a conversation of two turns plays exactly two requests', async () => {
  const { run, log } = setup();
  assert.deepEqual(await run({ plan: plan(['alice', 'bob']) }), { delivered: 2 });
  assert.equal(log.requests.at(-1).conversation.isLast, true);
});
