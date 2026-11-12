import { withTimeout } from '../util/withTimeout.js';
import { toHistoryMessage } from '../discord/historyMessage.js';

const fetchPage = ({ channelHistory, config, clock }, channel, { before, limit }) => withTimeout(
  channelHistory.fetchBefore(channel, { before, limit, throwOnError: true, cache: false }),
  {
    ms: config.backfill.pageTimeoutMs,
    label: `History page before ${before ?? 'the newest message'}`,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  },
);

const fetchWithRetry = async (ctx, channel, request) => {
  const { pageRetries, retryDelayMs } = ctx.config.backfill;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchPage(ctx, channel, request);
    } catch (error) {
      if (attempt >= pageRetries) throw error;
      ctx.logger.warn(`History page failed (attempt ${attempt + 1} of ${pageRetries + 1}); retrying:`, error);
      await ctx.clock.sleep(retryDelayMs);
    }
  }
};

// Pages arrive newest first, each oldest first inside; joining them reversed gives oldest first overall.
const readAll = async (ctx, channel, { before = null, limit = Infinity } = {}) => {
  const { pageSize } = ctx.config.backfill;
  const pages = [];
  let fetched = 0;
  let cursor = before ?? undefined;
  while (fetched < limit) {
    const page = await fetchWithRetry(ctx, channel, { before: cursor, limit: Math.min(pageSize, limit - fetched) });
    if (page.length === 0) break;
    pages.push(page.map(toHistoryMessage));
    fetched += page.length;
    cursor = page[0].id;
    ctx.logger.info(`Fetched ${fetched} messages so far.`);
  }
  return pages.reverse().flat();
};

export const createHistoryReader = (deps) => ({ readAll: (channel, options) => readAll(deps, channel, options) });
