// Finds the bot message a human message replies to, or null when it replies to anything else.
export const createBotParentFinder = ({ botMessageStore, messageStore, botMessageResolver, logger }) => {
  // The referenced message may be a bot message from before the bot message store existed.
  const fetchFallback = async (message, id) => {
    try {
      const fetched = await message.fetchReference();
      const resolved = botMessageResolver.resolve(fetched);
      return resolved && { id, persona: resolved.persona, content: resolved.content, reference: null, fallback: true };
    } catch (error) {
      logger.warn(`Could not fetch the referenced message ${id}; treating it as not a bot message:`, error);
      return null;
    }
  };

  const find = async (message, record) => {
    const id = record.reference;
    if (!id) return null;
    const stored = botMessageStore.getById(id);
    if (stored) return stored;
    if (messageStore.getRaw(id)) return null;
    return fetchFallback(message, id);
  };

  return { find };
};
