import { withTimeout } from '../util/withTimeout.js';
import { toHistoryMessage } from '../discord/historyMessage.js';

export const createHistoryReader = ({ channelHistory, config, clock, logger }) => {
  const { pageSize, pageRetries, retryDelayMs, pageTimeoutMs } = config.backfill;

  const fetchPage = (channel, { before, limit }) => withTimeout(
    channelHistory.fetchBefore(channel, { before, limit, throwOnError: true, cache: false }),
    {
      ms: pageTimeoutMs,
      label: `History page before ${before ?? 'the newest message'}`,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );

  const fetchWithRetry = async (channel, request) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetchPage(channel, request);
      } catch (error) {
        if (attempt >= pageRetries) throw error;
        logger.warn(`History page failed (attempt ${attempt + 1} of ${pageRetries + 1}); retrying:`, error);
        await clock.sleep(retryDelayMs);
      }
    }
  };

  // Pages arrive newest first, each oldest first inside; joining them reversed gives oldest first overall.
  const readAll = async (channel, { before = null, limit = Infinity } = {}) => {
    const pages = [];
    let fetched = 0;
    let cursor = before ?? undefined;
    while (fetched < limit) {
      const page = await fetchWithRetry(channel, { before: cursor, limit: Math.min(pageSize, limit - fetched) });
      if (page.length === 0) break;
      pages.push(page.map(toHistoryMessage));
      fetched += page.length;
      cursor = page[0].id;
      logger.info(`Fetched ${fetched} messages so far.`);
    }
    return pages.reverse().flat();
  };

  return { readAll };
};
