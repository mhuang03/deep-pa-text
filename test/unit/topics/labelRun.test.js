import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelClusters } from '../../../src/topics/labelRun.js';
import { DEFAULTS } from '../../../src/config.js';

const plan = (size) => ({
  cluster: { size, authorCount: 3, cohesion: 0.5, medianTimestamp: 9, authors: [{ author: 'a', share: 1, newestTimestamp: 1 }] },
  representatives: [{ id: `m${size}`, author: 'a', content: 'x' }],
});

const setup = (results, { hidden = [], minFailures = 3 } = {}) => {
  const inserted = [];
  const lines = [];
  let call = 0;
  return {
    inserted,
    lines,
    ctx: {
      settings: { ...DEFAULTS.topics, maxConsecutiveFailures: minFailures },
      logger: { info: (line) => lines.push(line) },
      labeller: { label: async () => results[call++] ?? { status: 'rejected' } },
      topicStore: { hiddenLabelKeys: () => new Set(hidden), insertTopic: (topic) => inserted.push(topic) },
      buildId: 'b1',
    },
  };
};

const ok = (topic) => ({ status: 'accepted', topic, summary: `about ${topic}` });

test('stores each accepted cluster as it is labelled, with its representatives as messages', async () => {
  const { ctx, inserted } = setup([ok('One'), ok('Two')]);
  const { counts, reason } = await labelClusters(ctx, [plan(10), plan(20)]);
  assert.deepEqual(counts, { labelled: 2, rejected: 0, duplicate: 0, hidden: 0, failed: 0 });
  assert.equal(reason, null);
  assert.deepEqual(inserted.map((t) => [t.buildId, t.label, t.size, t.messages]), [['b1', 'One', 10, ['m10']], ['b1', 'Two', 20, ['m20']]]);
});

test('counts rejected, duplicate, hidden and failed outcomes separately and stores none of them', async () => {
  const results = [ok('Same'), { status: 'rejected' }, ok('same!'), ok('Secret'), { status: 'failed' }];
  const { ctx, inserted } = setup(results, { hidden: ['secret'] });
  const { counts } = await labelClusters(ctx, results.map((_, i) => plan(i + 1)));
  assert.deepEqual(counts, { labelled: 1, rejected: 1, duplicate: 1, hidden: 1, failed: 1 });
  assert.equal(inserted.length, 1);
});

test('stops after the configured number of consecutive failures', async () => {
  const failed = { status: 'failed' };
  const { ctx } = setup([failed, failed, failed, ok('Never')], { minFailures: 3 });
  const outcome = await labelClusters(ctx, [plan(1), plan(2), plan(3), plan(4)]);
  assert.equal(outcome.reason, 'llm-failing');
  assert.equal(outcome.counts.failed, 3);
  assert.equal(outcome.counts.labelled, 0);
});

test('a non-failure in between resets the streak', async () => {
  const failed = { status: 'failed' };
  const { ctx } = setup([failed, failed, ok('A'), failed, failed, ok('B')], { minFailures: 3 });
  const outcome = await labelClusters(ctx, Array.from({ length: 6 }, (_, i) => plan(i + 1)));
  assert.equal(outcome.reason, null);
  assert.equal(outcome.counts.labelled, 2);
  assert.equal(outcome.counts.failed, 4);
});

test('logs one line per cluster', async () => {
  const { ctx, lines } = setup([ok('One')]);
  await labelClusters(ctx, [plan(10)]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /10 messages: accepted/);
});
