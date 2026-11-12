// Discord's page size for message fetches.
export const MAX_FETCH_LIMIT = 100;

export const createChannelHistory = ({ logger }) => {
  // Discord returns newest first; callers want oldest first. By default a failure is logged and yields
  // no messages (context is optional); an import passes throwOnError so a gap is never mistaken for the end.
  const fetchBefore = async (channel, { before, limit, throwOnError = false, cache }) => {
    const options = { limit: Math.min(limit, MAX_FETCH_LIMIT), before };
    if (cache !== undefined) options.cache = cache;
    try {
      const page = await channel.messages.fetch(options);
      return [...page.values()].reverse();
    } catch (error) {
      if (throwOnError) throw error;
      logger.warn(`Could not fetch channel history before ${before}:`, error);
      return [];
    }
  };

  return { fetchBefore };
};
