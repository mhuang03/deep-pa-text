import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTopics } from '../../../src/container/topics.js';
import { buildAll } from '../../support/containerParts.js';

test('buildTopics returns the topic store, source and builder, wired to the shared chat client', async () => {
  const all = buildAll();
  const topics = buildTopics(all);
  assert.deepEqual(Object.keys(topics).sort(), ['topicBuilder', 'topicSource', 'topicStore']);
  assert.deepEqual(Object.keys(topics.topicBuilder), ['run']);
  assert.deepEqual(Object.keys(topics.topicSource).sort(), ['bankStatus', 'candidates', 'openers']);
  assert.deepEqual(topics.topicSource.bankStatus(), { topics: 0, completedAt: null, stale: true });
  assert.equal(typeof all.services.chatClient.complete, 'function');
  all.storage.db.close();
});

test('the topic services share the container database', () => {
  const all = buildAll();
  const id = all.topics.topicStore.insertTopic({
    buildId: 'b', label: 'L', summary: 'S', size: 1, authorCount: 1, cohesion: 1, medianTimestamp: 1, authors: [], messages: [],
  });
  all.topics.topicStore.completeBuild({ buildId: 'b', completedAt: 1, stats: {} });
  assert.equal(all.storage.db.prepare('SELECT id FROM topics').get().id, id);
  assert.equal(all.topics.topicSource.bankStatus().topics, 1);
  all.storage.db.close();
});
