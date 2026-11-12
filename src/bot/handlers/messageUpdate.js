import { toMessageRecord } from '../../discord/messageRecord.js';
import { formatFailure } from '../logLines.js';

export const createMessageUpdateHandler = ({ config, ingest, botMessageStore, clock, logger }) => {
  const isHandled = (message) => message.channelId === config.discord.channelId;

  // One extra REST call for edits of uncached messages.
  const resolve = (message) => (message.partial ? message.fetch() : message);

  const record = async (message) => {
    const { reference, ...rest } = toMessageRecord(message);
    const repliesToBot = Boolean(reference && botMessageStore.getById(reference));
    const editedAt = message.editedTimestamp ?? clock.now();
    await ingest.recordEdit({ ...rest, reference, editedAt }, { repliesToBot, tolerateVectorErrors: true });
  };

  // Edits are not channel activity: no tracker, no reply policy, never a reply.
  const onUpdate = async (oldMessage, newMessage) => {
    try {
      if (!isHandled(newMessage)) return;
      const fetched = await resolve(newMessage);
      if (fetched.author.bot) return;
      await record(fetched);
    } catch (error) {
      logger.error(formatFailure({ what: 'Error processing message edit', messageId: newMessage?.id }), error);
    }
  };

  return { onUpdate };
};
