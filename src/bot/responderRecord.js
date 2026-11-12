export const createBotMessageRecorder = ({ botMessageStore, clock, logger }) => ({
  record: ({ message, text, persona, target, trigger }) => {
    if (!message?.id) {
      logger.warn(`Sent message has no id; bot message not recorded (${trigger}, ${persona})`);
      return;
    }
    try {
      botMessageStore.insert({
        id: message.id,
        persona,
        content: text,
        timestamp: message.createdTimestamp ?? clock.now(),
        reference: target?.id ?? null,
        trigger,
      });
    } catch (error) {
      logger.error(`Could not record bot message ${message.id}:`, error);
    }
  },
});
