import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTopicBuilder } from '../../../src/topics/topicBuilder.js';
import { themedMessages, SHORT_FILLER, SNEAKY_FILLER, labelByTheme } from '../../support/topicFixtures.js';
import { setupBuilder, NOW, OLD } from '../../support/topicBuilderWorld.js';

const FOUR = ['alice', 'bob', 'carol', 'dave'];
const themes = (names, { count = 30, authors = FOUR } = {}) =>
  names.flatMap((theme) => themedMessages({ theme, authors, count, timestamp: OLD }));

const countRows = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('builds a bank: one topic per usable theme, with authors, samples and a completed build', async () => {
  const { builder, topicStore, db } = setupBuilder({ rows: themes(['camping', 'cooking', 'gaming']) });
  const report = await builder.run();
  assert.equal(report.reason, undefined);
  assert.deepEqual(
    [report.sampled, report.eligible, report.embedded, report.clusters, report.kept, report.labelled],
    [90, 90, 90, 3, 3, 3],
  );
  assert.deepEqual([report.rejected, report.duplicate, report.hidden, report.failed], [0, 0, 0, 0]);
  const topics = topicStore.currentTopics();
  assert.deepEqual(topics.map((t) => t.label).sort(), ['Talking about camping', 'Talking about cooking', 'Talking about gaming']);
  topics.forEach((topic) => {
    assert.equal(topic.size, 30);
    assert.equal(topic.authorCount, 4);
    assert.equal(topic.medianTimestamp > OLD, true);
    assert.equal(topicStore.samplesOf(topic.id, 100).length, 8);
  });
  assert.equal(topicStore.currentBuild().buildId, report.buildId);
  assert.equal(topicStore.currentBuild().completedAt, NOW);
  assert.equal(JSON.parse(db.prepare('SELECT stats FROM topic_builds').get().stats).labelled, 3);
});

test('the build id is t, the UTC time and four hex digits', async () => {
  const { builder } = setupBuilder({ rows: themes(['camping', 'cooking', 'gaming']) });
  const { buildId } = await builder.run({ dryRun: true });
  assert.match(buildId, /^t20261112180000-[0-9a-f]{4}$/);
});

test('short messages and filler never enter a cluster and never become representatives', async () => {
  const filler = Array.from({ length: 150 }, (_, i) => ({
    id: `f${i}`, author: FOUR[i % 4], timestamp: OLD,
    content: i % 3 === 0 ? SHORT_FILLER[i % 5] : `${SNEAKY_FILLER[i % 3]} ${i}`,
  }));
  const rows = [...themes(['camping', 'cooking', 'gaming']), ...filler];
  const { builder, topicStore, requests } = setupBuilder({ rows });
  const report = await builder.run();
  assert.equal(report.labelled, 3);
  assert.equal(report.eligible, 90);
  const sampled = topicStore.currentTopics().flatMap((t) => topicStore.samplesOf(t.id, 100));
  assert.ok(sampled.every((s) => !/^(yeah|ok|yes|lol|haha|absolutely|hahaha)/.test(s.text)));
  requests.forEach((request) => assert.ok(!/yeah|absolutely/.test(request.user)));
});

test('a catchphrase repeated many times by one person is dropped by the repeat rule', async () => {
  const phrase = 'I swear this is the best thing ever honestly';
  const catchphrase = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, author: 'alice', content: phrase, timestamp: OLD }));
  const { builder } = setupBuilder({ rows: [...themes(['camping', 'cooking', 'gaming']), ...catchphrase] });
  const report = await builder.run({ dryRun: true });
  assert.equal(report.sampled, 110);
  assert.equal(report.eligible, 90);
});

test('rows of authors outside the user directory are dropped before clustering', async () => {
  const strangers = themedMessages({ theme: 'music', authors: ['mallory'], count: 30, timestamp: OLD });
  const { builder } = setupBuilder({ rows: [...themes(['camping', 'cooking', 'gaming']), ...strangers] });
  const report = await builder.run({ dryRun: true });
  assert.equal(report.eligible, 90);
});

test('a cluster written by a single author is rejected by the author rule', async () => {
  const rows = [...themes(['camping', 'cooking', 'gaming']), ...themedMessages({ theme: 'music', authors: ['alice'], count: 30, timestamp: OLD })];
  const { builder } = setupBuilder({ rows, topics: { minClusters: 4, maxClusters: 4 } });
  const report = await builder.run();
  assert.equal(report.clusters, 4);
  assert.equal(report.kept, 3);
  assert.equal(report.labelled, 3);
});

test('with a two-person directory the author rule requires two authors', async () => {
  const users = [{ username: 'alice', name: 'A' }, { username: 'bob', name: 'B' }];
  const rows = themes(['camping', 'cooking', 'gaming'], { authors: ['alice', 'bob'] });
  const { builder } = setupBuilder({ rows, users });
  assert.equal((await builder.run({ dryRun: true })).kept, 3);
  const oneAuthor = themes(['camping', 'cooking', 'gaming'], { authors: ['alice'] });
  assert.equal((await setupBuilder({ rows: oneAuthor, users }).builder.run({ dryRun: true })).kept, 0);
});

test('a cluster the model calls unusable is rejected and counted', async () => {
  const answer = (request) => (request.user.includes('game')
    ? JSON.stringify({ usable: false, topic: '', summary: '' }) : labelByTheme(request));
  const { builder, topicStore } = setupBuilder({ rows: themes(['camping', 'cooking', 'gaming', 'music']), answer, topics: { minClusters: 4, maxClusters: 4 } });
  const report = await builder.run();
  assert.equal(report.rejected >= 1, true);
  assert.equal(report.labelled + report.rejected, 4);
  assert.equal(topicStore.currentTopics().length, report.labelled);
});

test('prose around the JSON is parsed; invalid JSON and a throwing client are failures and the run continues', async () => {
  const answers = [
    (request) => `Here is my answer:\n${labelByTheme(request)}\nThanks.`,
    () => 'this is not json at all',
    () => new Error('upstream 500'),
    (request) => labelByTheme(request),
  ];
  const answer = (request, n) => answers[n - 1](request);
  const { builder, topicStore, warnings } = setupBuilder({
    rows: themes(['camping', 'cooking', 'gaming', 'music']), answer, topics: { minClusters: 4, maxClusters: 4, minTopics: 1 },
  });
  const report = await builder.run();
  assert.equal(report.failed, 2);
  assert.equal(report.labelled, 2);
  assert.equal(report.reason, undefined);
  assert.equal(topicStore.currentTopics().length, 2);
  assert.equal(warnings.length, 2);
});

test('two clusters with the same label key: the second is a duplicate and is skipped', async () => {
  const labels = ['Weekend plans', 'weekend plans!', 'Something else', 'Another subject'];
  const answer = (request, n) => JSON.stringify({ usable: true, topic: labels[n - 1], summary: 'x' });
  const { builder, topicStore } = setupBuilder({
    rows: themes(['camping', 'cooking', 'gaming', 'music']), answer, topics: { minClusters: 4, maxClusters: 4 },
  });
  const report = await builder.run();
  assert.equal(report.duplicate, 1);
  assert.equal(report.labelled, 3);
  assert.equal(topicStore.currentTopics().length, 3);
});

test('a label of a hidden topic is skipped, so a hide survives a rebuild', async () => {
  const first = setupBuilder({ rows: themes(['camping', 'cooking', 'gaming']) });
  await first.builder.run();
  const hidden = first.topicStore.currentTopics().find((t) => t.label === 'Talking about camping');
  first.topicStore.hide(hidden.id, 5);
  // a later build on the same database
  const second = setupBuilder({ rows: [], db: first.db });
  assert.deepEqual([...second.topicStore.hiddenLabelKeys()], ['talking about camping']);
  const rebuilt = setupBuilder({ rows: themes(['camping', 'cooking', 'gaming', 'music']), topics: { minClusters: 4, maxClusters: 4 }, db: first.db });
  const report = await rebuilt.builder.run();
  assert.equal(report.hidden, 1);
  assert.equal(report.labelled, 3);
  assert.ok(!rebuilt.topicStore.currentTopics().some((t) => t.label === 'Talking about camping'));
});

test('label and summary have whitespace collapsed and are cut to the configured limits', async () => {
  const answer = () => JSON.stringify({ usable: true, topic: '  A   very\n long   label  ', summary: 'Summary   with\n\nspaces and more words' });
  const rows = themes(['camping', 'cooking', 'gaming', 'music']);
  const { builder, topicStore } = setupBuilder({
    rows, answer, topics: { minClusters: 4, maxClusters: 4, minTopics: 1, maxLabelChars: 12, maxSummaryChars: 14 },
  });
  await builder.run();
  const [topic] = topicStore.currentTopics();
  assert.equal(topic.label, 'A very long');
  assert.equal(topic.summary, 'Summary with s');
});

test('rows whose embedding is missing from the vector store are skipped and counted', async () => {
  const rows = themes(['camping', 'cooking', 'gaming']);
  const missing = rows.slice(0, 5).map((r) => r.id);
  const { builder, vectorStore } = setupBuilder({ rows, missing });
  const report = await builder.run({ dryRun: true });
  assert.equal(report.eligible, 90);
  assert.equal(report.embedded, 85);
  assert.ok(vectorStore.calls.every((c) => c.options.batch === true));
});

test('embeddings are read in pages of the configured size', async () => {
  const { builder, vectorStore } = setupBuilder({ rows: themes(['camping', 'cooking', 'gaming']), topics: { embeddingPageSize: 40 } });
  await builder.run({ dryRun: true });
  assert.deepEqual(vectorStore.calls.map((c) => c.ids.length), [40, 40, 10]);
});

test('too few embedded messages stops the run with a reason and writes nothing', async () => {
  const rows = themes(['camping'], { count: 20 });
  const { builder, db, requests } = setupBuilder({ rows });
  const report = await builder.run();
  assert.equal(report.reason, 'too-few-messages');
  assert.equal(requests.length, 0);
  assert.equal(countRows(db, 'topics'), 0);
  assert.equal(countRows(db, 'topic_builds'), 0);
});

test('a dry run makes no LLM call, writes nothing and previews each kept cluster with five representatives', async () => {
  const { builder, db, requests } = setupBuilder({ rows: themes(['camping', 'cooking', 'gaming']) });
  const report = await builder.run({ dryRun: true });
  assert.equal(requests.length, 0);
  assert.equal(countRows(db, 'topics'), 0);
  assert.equal(countRows(db, 'topic_builds'), 0);
  assert.equal(report.preview.length, 3);
  report.preview.forEach((entry) => {
    assert.deepEqual(Object.keys(entry).sort(), ['authorCount', 'cohesion', 'representatives', 'size']);
    assert.equal(entry.representatives.length, 5);
    assert.deepEqual(Object.keys(entry.representatives[0]).sort(), ['author', 'text']);
  });
  assert.equal(report.labelled, 0);
});

test('maxMessages limits the sample', async () => {
  const { builder, vectorStore } = setupBuilder({ rows: themes(['camping', 'cooking', 'gaming']) });
  const report = await builder.run({ dryRun: true, maxMessages: 60 });
  assert.equal(report.eligible, 60);
  assert.equal(vectorStore.calls.flatMap((c) => c.ids).length, 60);
});

test('the labelling loop stops after consecutive failures and no build is completed', async () => {
  const { builder, topicStore, db, requests } = setupBuilder({
    rows: themes(['camping', 'cooking', 'gaming', 'music']), answer: () => new Error('down'),
    topics: { minClusters: 4, maxClusters: 4, maxConsecutiveFailures: 3 },
  });
  const report = await builder.run();
  assert.equal(report.reason, 'llm-failing');
  assert.equal(report.failed, 3);
  assert.equal(requests.length, 3);
  assert.equal(topicStore.currentBuild(), null);
  assert.equal(countRows(db, 'topic_builds'), 0);
});

test('a success resets the failure streak', async () => {
  const outcomes = [new Error('x'), new Error('x'), null, new Error('x'), new Error('x')];
  const answer = (request, n) => outcomes[n - 1] ?? labelByTheme(request);
  const { builder } = setupBuilder({
    rows: themes(['camping', 'cooking', 'gaming', 'music', 'camping']), answer,
    topics: { minClusters: 5, maxClusters: 5, maxConsecutiveFailures: 3, minTopics: 1, minAuthors: 2 },
  });
  const report = await builder.run();
  assert.notEqual(report.reason, 'llm-failing');
});

test('fewer accepted topics than minTopics reports too-few-topics and keeps the previous bank current', async () => {
  const rows = themes(['camping', 'cooking', 'gaming']);
  const first = setupBuilder({ rows });
  await first.builder.run();
  const before = first.topicStore.currentTopics().map((t) => t.id);
  const onlyFirst = (request, n) => (n === 1 ? labelByTheme(request) : JSON.stringify({ usable: false }));
  const weak = setupBuilder({ rows, db: first.db, answer: onlyFirst, seed: 2, now: NOW + 1000 });
  const report = await weak.builder.run();
  assert.equal(report.reason, 'too-few-topics');
  assert.equal(report.labelled, 1);
  assert.equal(countRows(first.db, 'topics'), 4, 'the orphan row is kept, just ignored');
  assert.equal(countRows(first.db, 'topic_builds'), 1);
  assert.deepEqual(weak.topicStore.currentTopics().map((t) => t.id), before);
});

test('a second successful build becomes current and the old rows still exist', async () => {
  const rows = themes(['camping', 'cooking', 'gaming']);
  const first = setupBuilder({ rows });
  const a = await first.builder.run();
  const second = setupBuilder({ rows, db: first.db, seed: 2, now: NOW + 1000 });
  const b = await second.builder.run();
  assert.notEqual(a.buildId, b.buildId);
  assert.equal(second.topicStore.currentBuild().buildId, b.buildId);
  assert.equal(second.topicStore.currentTopics().length, 3);
  assert.equal(countRows(first.db, 'topics'), 6);
  assert.equal(countRows(first.db, 'topic_builds'), 2);
});

test('an interrupted build (the process dies after three topics) leaves the previous bank current', async () => {
  const rows = themes(['camping', 'cooking', 'gaming', 'music']);
  const first = setupBuilder({ rows, topics: { minClusters: 4, maxClusters: 4 } });
  await first.builder.run();
  const before = first.topicStore.currentTopics().map((t) => t.id);
  const dies = (request, n) => (n === 4 ? new Error('process died') : labelByTheme(request));
  const second = setupBuilder({
    rows, db: first.db, answer: dies, seed: 2, now: NOW + 1000, topics: { minClusters: 4, maxClusters: 4, maxConsecutiveFailures: 1 },
  });
  const report = await second.builder.run();
  assert.equal(report.reason, 'llm-failing');
  assert.equal(countRows(first.db, 'topics'), 7);
  assert.deepEqual(second.topicStore.currentTopics().map((t) => t.id), before);
});

test('the factory returns only run', () => {
  const deps = { config: { topics: {} }, userDirectory: {}, logger: {} };
  assert.deepEqual(Object.keys(createTopicBuilder(deps)), ['run']);
});
