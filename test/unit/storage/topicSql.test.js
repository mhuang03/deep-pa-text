import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import * as topicSql from '../../../src/storage/topicSql.js';
import * as messageTopicSql from '../../../src/storage/messageTopicSql.js';

test('every topic statement prepares against the migrated schema', () => {
  const db = openDatabase(':memory:');
  Object.values({ ...topicSql, ...messageTopicSql }).forEach((text) => assert.doesNotThrow(() => db.prepare(text), text));
});

test('the only UPDATE is the guarded deleted_at marker', () => {
  const updates = Object.values({ ...topicSql, ...messageTopicSql }).filter((text) => /\bUPDATE\b/i.test(text));
  assert.deepEqual(updates, [topicSql.HIDE_TOPIC]);
  assert.match(topicSql.HIDE_TOPIC, /SET deleted_at = \? WHERE id = \? AND deleted_at IS NULL/);
});

test('no topic statement deletes or replaces', () => {
  Object.values({ ...topicSql, ...messageTopicSql }).forEach((text) => assert.doesNotMatch(text, /\b(DELETE|DROP|REPLACE|TRUNCATE)\b/i));
});
