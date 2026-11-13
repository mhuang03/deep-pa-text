import { createTopicStore } from '../storage/topicStore.js';
import { createTopicBuilder } from '../topics/topicBuilder.js';
import { createTopicSource } from '../topics/topicSource.js';

// The topic bank: built by the topics script, read by the bot. The chat client is shared with generation.
export const buildTopics = ({ config, clock, logger, storage, services }) => {
  const { db, messageStore, vectorStore, userDirectory } = storage;
  const topicStore = createTopicStore({ db });
  const topicSource = createTopicSource({
    topicStore, messageStore, vectorStore, userDirectory, random: clock.random, clock, config, logger,
  });
  const topicBuilder = createTopicBuilder({
    messageStore, vectorStore, topicStore, chatClient: services.chatClient, userDirectory,
    random: clock.random, clock, config, logger,
  });
  return { topicStore, topicSource, topicBuilder };
};
