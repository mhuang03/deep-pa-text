import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMessageRecord } from '../../../src/discord/messageRecord.js';
import { createFakeDiscord } from '../../support/fakes/discord.js';

test('maps a message without a reference', () => {
  const message = createFakeDiscord().makeMessage({ id: 'm1', author: 'bob', content: 'hey', timestamp: 42 });
  assert.deepEqual(toMessageRecord(message), {
    id: 'm1', author: 'bob', content: 'hey', timestamp: 42, reference: null,
  });
});

test('maps the referenced message id', () => {
  const message = createFakeDiscord().makeMessage({ id: 'm2', reference: 'm1', timestamp: 5 });
  assert.equal(toMessageRecord(message).reference, 'm1');
});

test('treats an empty reference id as no reference', () => {
  const message = { id: 'm', author: { username: 'a' }, content: 'c', createdTimestamp: 1, reference: { messageId: '' } };
  assert.equal(toMessageRecord(message).reference, null);
});
