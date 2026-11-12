import { syncPage } from './vectorSyncSteps.js';

const emptyCounts = () => ({ checked: 0, addedMessages: 0, filledMetadata: 0, addedReplies: 0, skipped: 0 });

const addCounts = (total, page) => Object.fromEntries(Object.keys(total).map((key) => [key, total[key] + page[key]]));

// `sinceMs` limits the check to rows at or after that time, for the automatic repair.
const run = async (ctx, { dryRun = false, sinceMs = null, quiet = false } = {}) => {
  const { messageStore, logger, config } = ctx;
  let totals = emptyCounts();
  let after = sinceMs === null ? null : { timestamp: sinceMs, id: '' };
  for (;;) {
    const rows = messageStore.pageFiltered({ after, limit: config.backfill.batchSize });
    if (rows.length === 0) return totals;
    totals = addCounts(totals, await syncPage(ctx, rows, dryRun));
    const last = rows.at(-1);
    after = { timestamp: last.timestamp, id: last.id };
    if (!quiet) logger.info(`Checked ${totals.checked} corpus rows against Chroma.`);
  }
};

export const createVectorSync = ({ messageStore, vectorStore, logger, config }) => {
  const ctx = { messageStore, vectorStore, logger, config };
  return { run: (options) => run(ctx, options) };
};
