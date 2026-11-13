import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationPolicy } from '../../../../src/bot/conversation/conversationPolicy.js';
import { loadConfig } from '../../../../src/config.js';

const HOUR = 3600000;
const NOW = 100 * HOUR;

const setup = ({ env = {}, last = null, roll = 0.05, chance } = {}) => {
  const rolls = [];
  const queries = [];
  const base = loadConfig({ CONVERSATIONS: 'true', ...env });
  const config = chance === undefined ? base : { ...base, conversation: { ...base.conversation, chance } };
  const policy = createConversationPolicy({
    botMessageStore: { newest: (arg) => (queries.push(arg), last) },
    random: () => (rolls.push(roll), roll),
    now: () => NOW,
    config,
  });
  return { policy, rolls, queries };
};

test('disabled: never starts and never rolls or reads the store', () => {
  const { policy, rolls, queries } = setup({ env: { CONVERSATIONS: 'false' } });
  assert.deepEqual(policy.decide(), { start: false, reason: 'disabled' });
  assert.deepEqual([rolls, queries], [[], []]);
});

test('a chance of 0 is treated like disabled: no roll', () => {
  const { policy, rolls } = setup({ chance: 0 });
  assert.deepEqual(policy.decide(), { start: false, reason: 'disabled' });
  assert.deepEqual(rolls, []);
});

test('a conversation 23 hours ago is too soon and consumes no roll', () => {
  const { policy, rolls, queries } = setup({ last: { timestamp: NOW - 23 * HOUR } });
  assert.deepEqual(policy.decide(), { start: false, reason: 'too-soon' });
  assert.deepEqual(rolls, []);
  assert.deepEqual(queries, [{ triggers: ['conversation'] }]);
});

test('the interval boundary: 1 ms short is too soon, exactly 24 hours rolls', () => {
  assert.equal(setup({ last: { timestamp: NOW - 24 * HOUR + 1 } }).policy.decide().reason, 'too-soon');
  assert.equal(setup({ last: { timestamp: NOW - 24 * HOUR } }).policy.decide().start, true);
});

test('25 hours ago with a roll of 0.05 starts a conversation and reports the roll', () => {
  const { policy, rolls } = setup({ last: { timestamp: NOW - 25 * HOUR }, roll: 0.05 });
  assert.deepEqual(policy.decide(), { start: true, roll: 0.05 });
  assert.equal(rolls.length, 1);
});

test('25 hours ago with a roll of 0.5 does not start and reports the roll', () => {
  const { policy } = setup({ last: { timestamp: NOW - 25 * HOUR }, roll: 0.5 });
  assert.deepEqual(policy.decide(), { start: false, reason: 'roll', roll: 0.5 });
});

test('the roll boundary is strict: a roll equal to the chance does not start', () => {
  assert.equal(setup({ roll: 0.1 }).policy.decide().start, false);
  assert.equal(setup({ roll: 0.0999 }).policy.decide().start, true);
  assert.equal(setup({ roll: 0 }).policy.decide().start, true);
});

test('with no earlier conversation the first one needs only the roll', () => {
  assert.equal(setup({ last: null, roll: 0.01 }).policy.decide().start, true);
});

test('each decision rolls exactly once', () => {
  const { policy, rolls } = setup({ roll: 0.9 });
  policy.decide();
  policy.decide();
  assert.equal(rolls.length, 2);
});
