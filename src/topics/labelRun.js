import { normalizeForDedup } from '../text/normalize.js';

const COUNTER = { accepted: 'labelled', rejected: 'rejected', duplicate: 'duplicate', hidden: 'hidden', failed: 'failed' };

// Labels one cluster and, when it is accepted, stores it at once so an interrupted run keeps its progress.
const labelOne = async (ctx, plan, { seen, hiddenKeys }) => {
  const { labeller, topicStore, buildId } = ctx;
  const result = await labeller.label(plan.representatives);
  if (result.status !== 'accepted') return result.status;
  const key = normalizeForDedup(result.topic);
  if (hiddenKeys.has(key)) return 'hidden';
  if (seen.has(key)) return 'duplicate';
  seen.add(key);
  const { cluster } = plan;
  topicStore.insertTopic({
    buildId,
    label: result.topic,
    summary: result.summary,
    size: cluster.size,
    authorCount: cluster.authorCount,
    cohesion: cluster.cohesion,
    medianTimestamp: cluster.medianTimestamp,
    authors: cluster.authors,
    messages: plan.representatives.map((row) => row.id),
  });
  return 'accepted';
};

// One call after another. Stops after too many failures in a row (the LLM is down, not the clusters).
export const labelClusters = async (ctx, plans) => {
  const { settings, logger } = ctx;
  const counts = { labelled: 0, rejected: 0, duplicate: 0, hidden: 0, failed: 0 };
  const state = { seen: new Set(), hiddenKeys: ctx.topicStore.hiddenLabelKeys() };
  let streak = 0;
  for (const plan of plans) {
    const outcome = await labelOne(ctx, plan, state);
    counts[COUNTER[outcome]] += 1;
    streak = outcome === 'failed' ? streak + 1 : 0;
    logger.info(`Topic cluster of ${plan.cluster.size} messages: ${outcome}`);
    if (streak >= settings.maxConsecutiveFailures) return { counts, reason: 'llm-failing' };
  }
  return { counts, reason: null };
};
