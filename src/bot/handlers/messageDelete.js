import { formatFailure } from '../logLines.js';

// Only id and channelId are read, so partial (uncached) messages work.
export const createMessageDeleteHandler = ({ config, ingest, clock, logger }) => {
  const isHandled = (message) => message.channelId === config.discord.channelId;

  const remove = (message) => {
    if (isHandled(message)) ingest.recordDelete(message.id, clock.now());
  };

  const onDelete = async (message) => {
    try {
      remove(message);
    } catch (error) {
      logger.error(formatFailure({ what: 'Error processing message delete', messageId: message?.id }), error);
    }
  };

  const onBulkDelete = async (messages) => {
    try {
      Array.from(messages.values()).forEach(remove);
    } catch (error) {
      logger.error('Error processing bulk message delete:', error);
    }
  };

  return { onDelete, onBulkDelete };
};
