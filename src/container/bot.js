import { createActivityTracker } from '../bot/activityTracker.js';
import { createReplyPolicy } from '../bot/replyPolicy.js';
import { createChainPolicy } from '../bot/chainPolicy.js';
import { createCommandLimiter } from '../bot/commandLimiter.js';
import { createChainBuilder } from '../context/chainBuilder.js';
import { createResponder } from '../bot/responder.js';
import { createMessageDeleteHandler } from '../bot/handlers/messageDelete.js';
import { createMessageUpdateHandler } from '../bot/handlers/messageUpdate.js';
import { createMessageCreateHandler } from '../bot/handlers/messageCreate.js';
import { createReplyCommandHandler } from '../bot/handlers/replyCommand.js';
import { createReviveTick } from '../bot/handlers/reviveTick.js';
import { createProfileRefresh } from '../bot/handlers/profileRefresh.js';
import { createBot } from '../bot/bot.js';
import { createLifecycle } from '../bot/lifecycle.js';
import { restoreState } from '../bot/stateRestore.js';

const buildHandlers = ({ config, data, clock, logger, parts }) => {
  const { client, storage, services, discord, responder, chainBuilder, activity, replyPolicy } = parts;
  const { ingest, personaSelector } = services;
  const { messageFilter, botMessageStore, messageStore } = storage;
  const { delivery, memberProfiles, botMessageResolver } = discord;
  const chainPolicy = createChainPolicy({ config, random: clock.random, now: clock.now });
  const commandLimiter = createCommandLimiter({ config, now: clock.now });
  const deleteHandler = createMessageDeleteHandler({ config, ingest, clock, logger });
  return {
    messageDelete: deleteHandler.onDelete,
    messageBulkDelete: deleteHandler.onBulkDelete,
    messageUpdate: createMessageUpdateHandler({
      config, ingest, botMessageStore, clock: { now: clock.now }, logger,
    }).onUpdate,
    messageCreate: createMessageCreateHandler({
      config, activity, ingest, messageFilter, replyPolicy, personaSelector, responder, logger,
      botMessageStore, messageStore, botMessageResolver, chainBuilder, chainPolicy,
    }),
    replyCommand: createReplyCommandHandler({
      client, config, users: data.users, messageFilter, personaSelector, responder,
      delivery, replyPolicy, botMessageResolver, commandLimiter, logger,
    }),
    profileRefresh: createProfileRefresh({ client, config, memberProfiles, logger }),
    reviveTick: createReviveTick({
      client, config, activity, personaSelector, responder, replyPolicy, clock: { now: clock.now }, logger,
      ...parts.conversation,
    }),
  };
};

// Decision and orchestration objects that sit between the Discord events and the services.
export const buildOrchestration = ({ config, clock, logger, storage, services, discord }) => {
  const { botMessageStore, messageStore, messageFilter, userDirectory } = storage;
  const responder = createResponder({
    composer: services.composer, delivery: discord.delivery, contextBuilder: discord.contextBuilder,
    botMessageStore, clock, config, logger,
  });
  const chainBuilder = createChainBuilder({ botMessageStore, messageStore, messageFilter, userDirectory, config });
  const activity = createActivityTracker({ now: clock.now });
  const replyPolicy = createReplyPolicy({ config, now: clock.now, random: clock.random });
  return { responder, chainBuilder, activity, replyPolicy };
};

export const buildLifecycle = ({ config, clock, logger, storage, discord, exit, closeDatabase }) => createLifecycle({
  client: discord.client, closeDatabase: closeDatabase ?? (() => storage.db.close()), clock, logger, exit, config,
});

const buildStartupTasks = ({ storage, orchestration, catchUp, clock }) => ({
  restoreState: ({ capped = false } = {}) => restoreState({
    messageStore: storage.messageStore, botMessageStore: storage.botMessageStore,
    activity: orchestration.activity, replyPolicy: orchestration.replyPolicy, now: clock.now, capped,
  }),
  catchUp: catchUp.run,
});

export const buildBot = ({ config, data, clock, logger, parts }) => {
  const { storage, services, discord, orchestration, lifecycle, topics, conversation, catchUp } = parts;
  const handlerParts = { ...orchestration, client: discord.client, storage, services, discord, conversation };
  const handlers = buildHandlers({ config, data, clock, logger, parts: handlerParts });
  const startupTasks = buildStartupTasks({ storage, orchestration, catchUp, clock });
  return createBot({
    client: discord.client, config, handlers, lifecycle, startupTasks, vectorHealth: services.vectorHealth,
    topicSource: topics.topicSource, logger,
  });
};
