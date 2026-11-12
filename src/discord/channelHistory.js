// Discord's page size for message fetches.
export const MAX_FETCH_LIMIT = 100;

export const createChannelHistory = ({ logger }) => {
  // Discord returns newest first; callers want oldest first.
  const fetchBefore = async (channel, { before, limit }) => {
    try {
      const page = await channel.messages.fetch({ limit: Math.min(limit, MAX_FETCH_LIMIT), before });
      return [...page.values()].reverse();
    } catch (error) {
      logger.warn(`Could not fetch channel history before ${before}:`, error);
      return [];
    }
  };

  return { fetchBefore };
};
