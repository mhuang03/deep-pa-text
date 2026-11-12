// Resolves the context a response is generated from; a failed lookup degrades to none.
const reviveContext = async ({ contextBuilder, clock, logger }, channel) => {
  try {
    return await contextBuilder.forRevive({ channel, nowMs: clock.now() });
  } catch (error) {
    logger.warn('Could not build revive context; continuing without it:', error);
    return {};
  }
};

// A failed transcript degrades to none, like a failed history fetch: the reply is still sent.
const replyContext = async ({ contextBuilder, logger }, { channel, target }) => {
  try {
    return await contextBuilder.forReply({ channel, target });
  } catch (error) {
    logger.warn(`Could not build the transcript for ${target.id}; continuing without it:`, error);
    return { transcript: [] };
  }
};

export const createContextResolver = (deps) => ({
  contextFor: (request) => {
    if (request.chain) return { chain: request.chain };
    return request.target === null ? reviveContext(deps, request.channel) : replyContext(deps, request);
  },
});
