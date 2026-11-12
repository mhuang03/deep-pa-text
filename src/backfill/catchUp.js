import { withTimeout } from '../util/withTimeout.js';
import { toHistoryMessage } from '../discord/historyMessage.js';
import { MAX_FETCH_LIMIT } from '../discord/channelHistory.js';

// Imports what was posted while the bot was down, paging forward from the newest stored message.
export const createCatchUp = ({
  channelHistory, historyImporter, messageStore, lifecycle, clock, config, logger,
}) => {
  const { maxMessages, enabled } = config.catchUp;
  const { pageTimeoutMs } = config.backfill;

  const fetchPage = (channel, { after, limit }) => withTimeout(
    channelHistory.fetchAfter(channel, { after, limit, throwOnError: true, cache: false }),
    {
      ms: pageTimeoutMs,
      label: `Catch-up page after ${after}`,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );

  const importPage = async (channel, page) => {
    const result = await historyImporter.importMessages(page.map(toHistoryMessage), { channel });
    return { insertedRaw: result.insertedRaw, kept: result.kept };
  };

  const run = async (channel) => {
    const totals = { fetched: 0, insertedRaw: 0, kept: 0, capped: false };
    if (!enabled) return totals;
    const newest = messageStore.newestRaw({ includeDeleted: true });
    if (!newest) return totals;
    let cursor = newest.id;
    let lastFull = false;
    while (totals.fetched < maxMessages && !lifecycle.isShuttingDown()) {
      const limit = Math.min(MAX_FETCH_LIMIT, maxMessages - totals.fetched);
      const page = await fetchPage(channel, { after: cursor, limit });
      if (page.length === 0) {
        lastFull = false;
        break;
      }
      const imported = await importPage(channel, page);
      totals.fetched += page.length;
      totals.insertedRaw += imported.insertedRaw;
      totals.kept += imported.kept;
      cursor = page.at(-1).id;
      lastFull = page.length === limit;
    }
    totals.capped = lastFull && totals.fetched >= maxMessages;
    if (totals.capped) {
      logger.warn(`Catch-up stopped after ${maxMessages} messages; run npm run backfill to import the rest.`);
    }
    return totals;
  };

  return { run };
};
