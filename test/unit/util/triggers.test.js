import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIGGERS } from '../../../src/util/triggers.js';

test('names every way a bot message can come about', () => {
  assert.deepEqual(TRIGGERS, {
    AUTO: 'auto', COMMAND: 'command', REVIVE: 'revive', CHAIN: 'chain', IMPORTED: 'imported', CONVERSATION: 'conversation',
    MENTION: 'mention',
  });
});

test('trigger values are distinct strings', () => {
  const values = Object.values(TRIGGERS);
  assert.equal(new Set(values).size, values.length);
  values.forEach((value) => assert.equal(typeof value, 'string'));
});
