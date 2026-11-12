import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBotMessageRecorder } from '../../../src/bot/responderRecord.js';

const setup = ({ failInsert = null } = {}) => {
  const rows = [];
  const logs = [];
  const { record } = createBotMessageRecorder({
    botMessageStore: { insert: (row) => { if (failInsert) throw failInsert; rows.push(row); } },
    clock: { now: () => 900 },
    logger: { warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) },
  });
  return { record, rows, logs };
};

test('stores the delivered message id, persona, text, reference and trigger', () => {
  const { record, rows } = setup();
  record({ message: { id: 'm1', createdTimestamp: 55 }, text: 'hi', persona: 'bob', target: { id: 't1' }, trigger: 'auto' });
  assert.deepEqual(rows, [{ id: 'm1', persona: 'bob', content: 'hi', timestamp: 55, reference: 't1', trigger: 'auto' }]);
});

test('uses the clock when the message has no timestamp and null when there is no target', () => {
  const { record, rows } = setup();
  record({ message: { id: 'm1' }, text: 'hi', persona: 'bob', target: null, trigger: 'revive' });
  assert.equal(rows[0].timestamp, 900);
  assert.equal(rows[0].reference, null);
});

test('warns and stores nothing when the sent message has no id', () => {
  const { record, rows, logs } = setup();
  record({ message: undefined, text: 'hi', persona: 'bob', target: null, trigger: 'auto' });
  assert.deepEqual(rows, []);
  assert.match(logs[0][1], /no id; bot message not recorded \(auto, bob\)/);
});

test('logs and swallows a failing insert', () => {
  const { record, logs } = setup({ failInsert: new Error('disk full') });
  assert.doesNotThrow(() => record({ message: { id: 'm1' }, text: 'hi', persona: 'bob', target: null, trigger: 'auto' }));
  assert.equal(logs[0][0], 'error');
  assert.match(logs[0][1], /Could not record bot message m1/);
});
