import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';
import { permutedMessages, labelByTheme, SHORT_FILLER, SNEAKY_FILLER } from '../support/topicFixtures.js';
import { seededRandom } from '../support/topicBuilderWorld.js';

const DAY = 86_400_000;
const CLUSTER_SETTINGS = { minClusters: 4, maxClusters: 4, minClusterSize: 10, representatives: 8 };
const THEME_AUTHORS = {
  camping: ['alice', 'bob', 'carol'],
  cooking: ['bob', 'carol', 'dave'],
  gaming: ['alice', 'dave', 'carol'],
  music: ['alice'],
};
const FILLER_COUNT = 60;

const corpus = () => {
  const timestamp = BASE_TIME - 30 * DAY;
  const themed = Object.entries(THEME_AUTHORS).flatMap(([theme, authors]) =>
    permutedMessages({ theme, authors, count: theme === 'music' ? 12 : 30, timestamp }));
  const filler = Array.from({ length: FILLER_COUNT }, (_, i) => ({
    id: `filler-${i}`, author: ['alice', 'bob', 'carol', 'dave'][i % 4], timestamp: timestamp + i,
    content: i % 3 === 0 ? SHORT_FILLER[i % 5] : `${SNEAKY_FILLER[i % 3]} ${i}`,
  }));
  return [...themed, ...filler];
};

const newWorld = async (t, topics = {}) => {
  const world = await createWorld({ random: seededRandom(7), config: { topics: { ...CLUSTER_SETTINGS, ...topics } } });
  t.after(() => world.close());
  world.llm.respondWith((request) => labelByTheme({ user: request.messages.at(-1).content }));
  await world.seed(corpus());
  return world;
};

const labelsOf = (topics) => topics.map((topic) => topic.label).sort();

test('builds the bank from themed groups: the single-author theme and the filler never become topics', async (t) => {
  const world = await newWorld(t);
  const { topicBuilder, topicStore } = world.container;
  const report = await topicBuilder.run();
  assert.equal(report.reason, undefined);
  assert.equal(report.clusters, 4);
  assert.equal(report.kept, 3);
  assert.equal(report.labelled, 3);
  assert.deepEqual([report.rejected, report.duplicate, report.hidden, report.failed], [0, 0, 0, 0]);
  const topics = topicStore.currentTopics();
  assert.deepEqual(labelsOf(topics), ['Talking about camping', 'Talking about cooking', 'Talking about gaming']);
  const byLabel = Object.fromEntries(topics.map((topic) => [topic.label, topic]));
  assert.deepEqual(byLabel['Talking about camping'].authors.map((a) => a.author).sort(), ['alice', 'bob', 'carol']);
  assert.deepEqual(byLabel['Talking about cooking'].authors.map((a) => a.author).sort(), ['bob', 'carol', 'dave']);
  topics.forEach((topic) => assert.equal(topic.size, 30));
});

test('no short or filler message is a representative, and the model never sees one', async (t) => {
  const world = await newWorld(t);
  await world.container.topicBuilder.run();
  const { topicStore } = world.container;
  const samples = topicStore.currentTopics().flatMap((topic) => topicStore.samplesOf(topic.id, 100));
  assert.ok(samples.length > 0);
  assert.ok(samples.every((sample) => /camp|cook|game/.test(sample.text)));
  world.llm.calls.forEach((call) => {
    assert.ok(!/yeah|absolutely|hahaha/.test(call.messages.at(-1).content));
  });
  assert.equal(world.llm.calls.length, 3);
});

test('the build calls the model once per kept cluster and nothing is written by a dry run', async (t) => {
  const world = await newWorld(t);
  const before = world.sqlite.get('SELECT COUNT(*) AS n FROM topics').n;
  const report = await world.container.topicBuilder.run({ dryRun: true });
  assert.equal(report.preview.length, 3);
  assert.equal(world.llm.calls.length, 0);
  assert.equal(world.sqlite.get('SELECT COUNT(*) AS n FROM topics').n, before);
  assert.equal(world.sqlite.get('SELECT COUNT(*) AS n FROM topic_builds').n, 0);
});

test('candidates returns the bank topics and then, with all of them excluded, a neighbourhood candidate', async (t) => {
  const world = await newWorld(t);
  await world.container.topicBuilder.run();
  const { topicSource, topicStore } = world.container;
  const banked = await topicSource.candidates({ limit: 5 });
  assert.equal(banked.length, 3);
  banked.forEach((candidate) => {
    assert.equal(typeof candidate.topicId, 'number');
    assert.ok(candidate.samples.length > 0 && candidate.samples.length <= 8);
    assert.ok(candidate.authors.length >= 2);
  });
  const excludeTopicIds = topicStore.currentTopics().map((topic) => topic.id);
  const fallback = await topicSource.candidates({ limit: 5, excludeTopicIds });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].topicId, null);
  assert.equal(fallback[0].label, null);
  assert.ok(fallback[0].authors.length >= 2);
  assert.ok(fallback[0].samples.every((sample) => /camp|cook|game/.test(sample.text)));
});

test('with Chroma failing, the fallback logs a warning and offers nothing', async (t) => {
  const world = await newWorld(t);
  world.fakes.chroma.state.failCollection('message_embeddings', new Error('chroma down'), ['query', 'get']);
  const found = await world.container.topicSource.candidates({ limit: 5 });
  assert.deepEqual(found, []);
  assert.ok(world.logs.warn.length >= 1);
});

test('a hidden topic stays out of the bank and out of the next build', async (t) => {
  const world = await newWorld(t);
  const { topicBuilder, topicStore } = world.container;
  await topicBuilder.run();
  const camping = topicStore.currentTopics().find((topic) => topic.label === 'Talking about camping');
  assert.equal(topicStore.hide(camping.id, BASE_TIME), true);
  assert.equal(topicStore.currentTopics().length, 2);
  assert.equal(world.sqlite.get('SELECT deleted_at FROM topics WHERE id = ?', camping.id).deleted_at, BASE_TIME);
  await world.advance(1000);
  const again = await topicBuilder.run();
  assert.equal(again.hidden, 1);
  assert.equal(again.labelled, 2);
  assert.equal(again.reason, 'too-few-topics');
  assert.equal(topicStore.currentTopics().length, 2, 'the weak rebuild did not replace the bank');
});

test('the openers come from messages that restarted a quiet channel', async (t) => {
  const world = await newWorld(t);
  const openers = world.container.topicSource.openers({ limit: 3 });
  assert.ok(openers.length >= 1 && openers.length <= 3);
  openers.forEach((opener) => assert.ok(['alice', 'bob', 'carol', 'dave'].includes(opener.author)));
});

test('the bank status says the bank is empty, then fresh after a build', async (t) => {
  const world = await newWorld(t);
  const { topicSource, topicBuilder } = world.container;
  assert.deepEqual(topicSource.bankStatus(), { topics: 0, completedAt: null, stale: true });
  await topicBuilder.run();
  const status = topicSource.bankStatus();
  assert.equal(status.topics, 3);
  assert.equal(status.stale, false);
  assert.equal(status.completedAt, world.now());
});
