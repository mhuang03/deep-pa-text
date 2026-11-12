// Discord's page size for message fetches.
export const MAX_FETCH_LIMIT = 100;

const pageOptions = (limit, cursor, cache) => {
  const options = { limit: Math.min(limit, MAX_FETCH_LIMIT), ...cursor };
  if (cache !== undefined) options.cache = cache;
  return options;
};

// Discord returns newest first; callers want oldest first. By default a failure is logged and yields
// no messages (context is optional); an import passes throwOnError so a gap is never mistaken for the end.
const fetchBefore = async ({ logger }, channel, { before, limit, throwOnError = false, cache }) => {
  try {
    const page = await channel.messages.fetch(pageOptions(limit, { before }, cache));
    return [...page.values()].reverse();
  } catch (error) {
    if (throwOnError) throw error;
    logger.warn(`Could not fetch channel history before ${before}:`, error);
    return [];
  }
};

// Snowflakes order by number; a non-numeric id (never from Discord) falls back to text order.
const compareIds = (a, b) => {
  try {
    const diff = BigInt(a) - BigInt(b);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
};

// Forward paging: the `limit` messages just after the cursor, oldest first. Throws on failure by default
// because a catch-up that mistook a gap for the end would skip messages.
const fetchAfter = async ({ logger }, channel, { after, limit, throwOnError = true, cache }) => {
  try {
    const page = await channel.messages.fetch(pageOptions(limit, { after }, cache));
    return [...page.values()].sort((a, b) => compareIds(a.id, b.id));
  } catch (error) {
    if (throwOnError) throw error;
    logger.warn(`Could not fetch channel history after ${after}:`, error);
    return [];
  }
};

export const createChannelHistory = ({ logger }) => ({
  fetchBefore: (channel, options) => fetchBefore({ logger }, channel, options),
  fetchAfter: (channel, options) => fetchAfter({ logger }, channel, options),
});
