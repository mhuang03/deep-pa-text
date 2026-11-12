import { createHistoryReader } from '../backfill/historyReader.js';
import { createBotMessageImporter } from '../backfill/botMessageImporter.js';
import { createHistoryImporter } from '../backfill/historyImporter.js';
import { createCatchUp } from '../backfill/catchUp.js';

// History import and catch-up; catch-up needs the lifecycle so it stops paging during shutdown.
export const buildBackfill = ({ config, clock, logger, storage, discord, services, lifecycle }) => {
  const { messageStore, botMessageStore, profileStore, userDirectory, messageFilter } = storage;
  const { client, channelHistory, webhooks } = discord;
  const historyReader = createHistoryReader({ channelHistory, config, clock, logger });
  const botMessageImporter = createBotMessageImporter({
    botMessageStore, profileStore, userDirectory, config, logger,
  });
  const historyImporter = createHistoryImporter({
    historyReader, botMessageImporter, ingest: services.ingest, messageStore, botMessageStore, messageFilter, webhooks,
    getBotUserId: () => client.user?.id, config, logger,
  });
  const catchUp = createCatchUp({
    channelHistory, historyImporter, messageStore, lifecycle, clock, config, logger,
  });
  return { historyReader, botMessageImporter, historyImporter, catchUp };
};
