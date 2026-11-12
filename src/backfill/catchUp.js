import { withTimeout } from '../util/withTimeout.js';
import { toHistoryMessage } from '../discord/historyMessage.js';
import { MAX_FETCH_LIMIT } from '../discord/channelHistory.js';

const fetchPage = ({ channelHistory, clock, config }, channel, { after, limit }) => withTimeout(
  channelHistory.fetchAfter(channel, { after, limit, throwOnError: true, cache: false }),
  {
    ms: config.backfill.pageTimeoutMs,
    label: `Catch-up page after ${after}`,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  },
);

const importPage = async ({ historyImporter }, channel, page) => {
  const result = await historyImporter.importMessages(page.map(toHistoryMessage), { channel });
  return { insertedRaw: result.insertedRaw, kept: result.kept };
};

// One page forward from the cursor; reports whether the page was empty and whether it was full.
const step = async (ctx, { channel, totals, cursor }) => {
  const { maxMessages } = ctx.config.catchUp;
  const limit = Math.min(MAX_FETCH_LIMIT, maxMessages - totals.fetched);
  const page = await fetchPage(ctx, channel, { after: cursor, limit });
  if (page.length === 0) return { done: true, lastFull: false };
  const imported = await importPage(ctx, channel, page);
  totals.fetched += page.length;
  totals.insertedRaw += imported.insertedRaw;
  totals.kept += imported.kept;
  return { done: false, lastFull: page.length === limit, cursor: page.at(-1).id };
};

const pageForward = async (ctx, { channel, totals, cursor: start }) => {
  const { maxMessages } = ctx.config.catchUp;
  let cursor = start;
  let lastFull = false;
  while (totals.fetched < maxMessages && !ctx.lifecycle.isShuttingDown()) {
    const next = await step(ctx, { channel, totals, cursor });
    lastFull = next.lastFull;
    if (next.done) break;
    cursor = next.cursor;
  }
  return lastFull;
};

const run = async (ctx, channel) => {
  const { messageStore, config, logger } = ctx;
  const { maxMessages, enabled } = config.catchUp;
  const totals = { fetched: 0, insertedRaw: 0, kept: 0, capped: false };
  if (!enabled) return totals;
  const newest = messageStore.newestRaw({ includeDeleted: true });
  if (!newest) return totals;
  const lastFull = await pageForward(ctx, { channel, totals, cursor: newest.id });
  totals.capped = lastFull && totals.fetched >= maxMessages;
  if (totals.capped) {
    logger.warn(`Catch-up stopped after ${maxMessages} messages; run npm run backfill to import the rest.`);
  }
  return totals;
};

// Imports what was posted while the bot was down, paging forward from the newest stored message.
export const createCatchUp = (deps) => ({ run: (channel) => run(deps, channel) });
