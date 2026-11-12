export const DELIVERY_STAGE = 'delivery';

// Lets handlers tell a send failure (arm the rate limit) from a generation failure.
const markDelivery = (error) => {
  const marked = error instanceof Error ? error : new Error(String(error), { cause: error });
  return Object.assign(marked, { stage: DELIVERY_STAGE });
};

export const createResponder = ({
  composer, delivery, contextBuilder, botMessageStore, now, logger,
}) => {
  const record = ({ message, response, persona, target, trigger }) => {
    if (!message?.id) {
      logger.warn(`Sent message has no id; bot message not recorded (${trigger}, ${persona})`);
      return;
    }
    try {
      botMessageStore.insert({
        id: message.id,
        persona,
        content: response,
        timestamp: message.createdTimestamp ?? now(),
        reference: target?.id ?? null,
        trigger,
      });
    } catch (error) {
      logger.error(`Could not record bot message ${message.id}:`, error);
    }
  };

  const send = async ({ via, persona, guild, content, gifLinks }) => {
    try {
      return await delivery.deliver({ via, persona, guild, content, gifLinks });
    } catch (error) {
      throw markDelivery(error);
    }
  };

  const contextFor = async ({ channel, target }) =>
    (target === null ? undefined : contextBuilder.forReply({ channel, target }));

  const respond = async ({ trigger, persona, target, guild, via, channel }) => {
    const context = await contextFor({ channel, target });
    const { response, content, gifLinks } = await composer.compose({ persona, target, context });
    const message = await send({ via, persona, guild, content, gifLinks });
    record({ message, response, persona, target, trigger });
    return { response, message };
  };

  return { respond };
};
