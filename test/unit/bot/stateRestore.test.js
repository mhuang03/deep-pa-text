import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreState } from '../../../src/bot/stateRestore.js';

const run = ({ human = null, bots = {}, capped = false, now = 10_000 } = {}) => {
  const activity = [];
  const policy = [];
  const queries = [];
  restoreState({
    messageStore: { newestRaw: () => human },
    botMessageStore: {
      newest: ({ triggers }) => {
        queries.push(triggers);
        return bots[triggers.join()] ?? null;
      },
    },
    activity: { restore: (s) => activity.push(s) },
    replyPolicy: { restore: (s) => policy.push(s) },
    now: () => now,
    capped,
  });
  return { activity, policy, queries };
};

const NATURAL = 'auto,revive,conversation';
const REPLIES = 'auto,chain,command,mention,conversation';

test('no stored human message leaves activity alone but still restores the rate limit', () => {
  const { activity, policy } = run({ bots: { [REPLIES]: { timestamp: 500 } } });
  assert.deepEqual(activity, []);
  assert.deepEqual(policy, [{ replyTime: 500 }]);
});

test('the last human message sets activity when no natural bot message is newer', () => {
  const { activity, policy } = run({ human: { timestamp: 100 }, bots: { [NATURAL]: { timestamp: 50 } } });
  assert.deepEqual(activity, [{ lastMessageTime: 100, lastWasBot: false }]);
  assert.deepEqual(policy, [{ replyTime: null }]);
});

test('a natural bot message newer than the last human one makes the bot the last speaker', () => {
  const { activity } = run({ human: { timestamp: 100 }, bots: { [NATURAL]: { timestamp: 150 } } });
  assert.deepEqual(activity, [{ lastMessageTime: 150, lastWasBot: true }]);
});

test('chain, command and mention replies restore the rate limit but not the activity', () => {
  const { activity, policy, queries } = run({ human: { timestamp: 100 }, bots: { [REPLIES]: { timestamp: 200 } } });
  assert.deepEqual(activity, [{ lastMessageTime: 100, lastWasBot: false }]);
  assert.deepEqual(policy, [{ replyTime: 200 }]);
  assert.deepEqual(queries, [['auto', 'revive', 'conversation'], ['auto', 'chain', 'command', 'mention', 'conversation']]);
});

test('a capped catch-up restores the fresh-start activity instead of the stored newest message', () => {
  const { activity, policy } = run({ human: { timestamp: 100 }, capped: true, now: 777, bots: { [REPLIES]: { timestamp: 5 } } });
  assert.deepEqual(activity, [{ lastMessageTime: 777, lastWasBot: true }]);
  assert.deepEqual(policy, [{ replyTime: 5 }]);
});

test('a conversation turn is a natural bot message: it makes the bot the last speaker when newest', () => {
  const { activity } = run({ human: { timestamp: 100 }, bots: { [NATURAL]: { timestamp: 150, trigger: 'conversation' } } });
  assert.deepEqual(activity, [{ lastMessageTime: 150, lastWasBot: true }]);
});

test('the last conversation turn restores the rate limit', () => {
  const { policy } = run({ human: { timestamp: 100 }, bots: { [REPLIES]: { timestamp: 300, trigger: 'conversation' } } });
  assert.deepEqual(policy, [{ replyTime: 300 }]);
});
