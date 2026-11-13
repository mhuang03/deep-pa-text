// The only place services are wired together; each layer's builder lives in src/container/.
import { buildStorage } from './container/storage.js';
import { buildServices } from './container/services.js';
import { buildDiscord } from './container/discord.js';
import { buildBackfill } from './container/backfill.js';
import { buildTopics } from './container/topics.js';
import { buildConversation } from './container/conversation.js';
import { buildOrchestration, buildLifecycle, buildBot } from './container/bot.js';
import { defaultClock } from './container/clock.js';

export { defaultClock } from './container/clock.js';
export { buildGifResolver } from './container/services.js';

// The public service map. Its keys are pinned by the container test.
const publicServices = ({
  logger, storage, services, discord, orchestration, lifecycle, backfill, topics, conversation, bot,
}) => ({
  bot, lifecycle, client: discord.client, logger,
  gifResolver: services.gifResolver, composer: services.composer, delivery: discord.delivery,
  responder: orchestration.responder, botMessageResolver: discord.botMessageResolver,
  contextBuilder: discord.contextBuilder, chainBuilder: orchestration.chainBuilder,
  memberProfiles: discord.memberProfiles, webhooks: discord.webhooks,
  historyReader: backfill.historyReader, botMessageImporter: backfill.botMessageImporter,
  historyImporter: backfill.historyImporter,
  ...storage,
  vectorSync: services.vectorSync, vectorHealth: services.vectorHealth, ingest: services.ingest,
  retriever: services.retriever, personaSelector: services.personaSelector, burstProfile: services.burstProfile,
  generator: services.generator, chatClient: services.chatClient,
  ...topics, ...conversation,
});

export const buildContainer = ({
  config, vendor, data, clock = defaultClock(), logger, cacheMessages = true, client: given = null,
  exit = () => {}, closeDatabase = null,
}) => {
  const storage = buildStorage({ config, vendor, data, clock });
  const services = buildServices({ config, vendor, data, clock, logger, storage });
  const discord = buildDiscord({ config, vendor, clock, logger, cacheMessages, given, storage });
  const orchestration = buildOrchestration({ config, clock, logger, storage, services, discord });
  const lifecycle = buildLifecycle({ config, clock, logger, storage, discord, exit, closeDatabase });
  const backfill = buildBackfill({ config, clock, logger, storage, discord, services, lifecycle });
  const topics = buildTopics({ config, clock, logger, storage, services });
  const wired = { storage, services, discord, orchestration, lifecycle, topics };
  const conversation = buildConversation({ config, clock, logger, parts: wired });
  const parts = { ...wired, conversation, catchUp: backfill.catchUp };
  const bot = buildBot({ config, data, clock, logger, parts });
  return publicServices({
    logger, storage, services, discord, orchestration, lifecycle, backfill, topics, conversation, bot,
  });
};
