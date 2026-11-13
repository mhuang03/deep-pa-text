import { clusterCount, kmeans } from '../util/kmeans.js';
import { createRowDot } from '../util/vectorMath.js';
import { utcStamp } from '../util/utcStamp.js';
import { buildMatrix } from './embeddingMatrix.js';
import { createTopicSampler } from './topicSampler.js';
import { createTopicLabeller } from './topicLabeller.js';
import { selectClusters } from './clusterFilter.js';
import { pickRepresentatives } from './representatives.js';
import { labelClusters } from './labelRun.js';

const PREVIEW_REPRESENTATIVES = 5;
const HEX_RADIX = 16;
const HEX_SPACE = 0x10000;
const HEX_DIGITS = 4;

// t<UTC YYYYMMDDHHMMSS>-<4 hex digits>, so two builds in one second still differ.
const newBuildId = ({ now, random }) => {
  const suffix = Math.floor(random() * HEX_SPACE).toString(HEX_RADIX).padStart(HEX_DIGITS, '0');
  return `t${utcStamp(now)}-${suffix}`;
};

const startReport = (buildId) => ({
  buildId, sampled: 0, eligible: 0, embedded: 0, clusters: 0, kept: 0,
  labelled: 0, rejected: 0, duplicate: 0, hidden: 0, failed: 0,
});

const planOf = (cluster, { matrix, centroids, settings }) => {
  const { vectors, dimensions, rows } = matrix;
  const toCentre = createRowDot(vectors, centroids, dimensions);
  const similarity = (row) => toCentre(row, cluster.index);
  const representatives = pickRepresentatives({
    members: cluster.members, rows, similarity, limit: settings.representatives,
  });
  return { cluster, representatives };
};

const previewOf = ({ cluster, representatives }) => ({
  size: cluster.size,
  authorCount: cluster.authorCount,
  cohesion: cluster.cohesion,
  representatives: representatives.slice(0, PREVIEW_REPRESENTATIVES)
    .map(({ author, content }) => ({ author, text: content })),
});

// Samples, embeds, clusters and filters; returns the clusters to label, or the reason to stop.
const prepare = async (ctx, { maxMessages, report }) => {
  const { settings, clock, vectorStore, sampler, userDirectory, random } = ctx;
  const sampled = sampler.sample({ maxMessages, now: clock.now() });
  report.sampled = sampled.sampled;
  report.eligible = sampled.rows.length;
  const matrix = await buildMatrix({ rows: sampled.rows, vectorStore, pageSize: settings.embeddingPageSize });
  report.embedded = matrix.rows.length;
  if (matrix.rows.length < settings.minClusters * settings.minClusterSize) return { reason: 'too-few-messages' };
  const clusters = clusterCount(matrix.rows.length, settings);
  const { assignments, centroids, cohesion } = kmeans({
    vectors: matrix.vectors, dimensions: matrix.dimensions, clusters, iterations: settings.iterations, random,
  });
  report.clusters = clusters;
  const kept = selectClusters({
    rows: matrix.rows, assignments, cohesion, directorySize: userDirectory.usernames.size, settings,
  });
  report.kept = kept.length;
  return { plans: kept.map((cluster) => planOf(cluster, { matrix, centroids, settings })) };
};

const finish = (ctx, { report, labelled }) => {
  const { topicStore, clock, settings } = ctx;
  const { counts } = labelled;
  const done = { ...report, ...counts };
  if (labelled.reason) done.reason = labelled.reason;
  if (counts.labelled < settings.minTopics) done.reason ??= 'too-few-topics';
  // A weak or broken run never replaces a good bank: without a topic_builds row its topics are ignored.
  if (done.reason) return done;
  topicStore.completeBuild({ buildId: report.buildId, completedAt: clock.now(), stats: done });
  return done;
};

export const createTopicBuilder = (deps) => {
  const { messageStore, vectorStore, topicStore, chatClient, userDirectory, random, clock, config, logger } = deps;
  const settings = config.topics;
  const sampler = createTopicSampler({ messageStore, userDirectory, config });
  const labeller = createTopicLabeller({ chatClient, logger, config });

  const run = async ({ dryRun = false, maxMessages = settings.maxMessages } = {}) => {
    const report = startReport(newBuildId({ now: clock.now(), random }));
    const ctx = { settings, clock, vectorStore, sampler, userDirectory, random };
    const prepared = await prepare(ctx, { maxMessages, report });
    if (prepared.reason) return { ...report, reason: prepared.reason };
    if (dryRun) return { ...report, preview: prepared.plans.map(previewOf) };
    const labelled = await labelClusters(
      { settings, logger, labeller, topicStore, buildId: report.buildId }, prepared.plans,
    );
    return finish({ topicStore, clock, settings }, { report, labelled });
  };

  return { run };
};
