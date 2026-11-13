import { createConversationPolicy } from '../bot/conversation/conversationPolicy.js';
import { createConversationPlanner } from '../bot/conversation/conversationPlanner.js';
import { createConversationRunner } from '../bot/conversation/conversationRunner.js';

// Scripted conversations: the planner chooses, the runner plays, the policy says when. Built with the
// handlers because the runner needs the lifecycle (shutdown) and the orchestration (responder, policies).
export const buildConversation = ({ config, clock, logger, parts }) => {
  const { storage, services, discord, orchestration, lifecycle, topics } = parts;
  const { botMessageStore, conversationStore, messageStore, userDirectory, vectorStore } = storage;
  const conversationPolicy = createConversationPolicy({
    botMessageStore, random: clock.random, now: clock.now, config,
  });
  const conversationPlanner = createConversationPlanner({
    topicSource: topics.topicSource, conversationStore, contextBuilder: discord.contextBuilder,
    chatClient: services.chatClient, vectorStore, messageStore, userDirectory,
    random: clock.random, clock, config, logger,
  });
  const conversationRunner = createConversationRunner({
    responder: orchestration.responder, replyPolicy: orchestration.replyPolicy, activity: orchestration.activity,
    lifecycle, random: clock.random, clock, config, logger,
  });
  return { conversationPolicy, conversationPlanner, conversationRunner };
};
