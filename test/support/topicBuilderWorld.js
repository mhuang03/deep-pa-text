// A topic builder over a real in-memory SQLite database, with the embeddings and the chat client faked.
import { openDatabase } from '../../src/storage/database.js';
import { createMessageStore } from '../../src/storage/messageStore.js';
import { createTopicStore } from '../../src/storage/topicStore.js';
import { createTopicBuilder } from '../../src/topics/topicBuilder.js';
import { buildUserDirectory } from '../../src/userData/loadData.js';
import { DEFAULTS } from '../../src/config.js';
import { USERS } from './fixtures.js';
import { createFakeVectorStore, insertRows, labelByTheme } from './topicFixtures.js';

export const NOW = Date.parse('2026-11-12T18:00:00Z');
export const OLD = NOW - 10_000_000;

export const seededRandom = (seed = 1) => {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

export const TEST_TOPICS = {
  minClusters: 3, maxClusters: 3, minClusterSize: 10, representatives: 8, maxMessages: 1000,
};

export const setupBuilder = ({
  rows, topics = {}, answer = labelByTheme, missing = [], users = USERS, db = openDatabase(':memory:'), seed = 1, now = NOW,
}) => {
  const config = {
    storage: { inferredReferenceWindowMs: 3600000, chunkSize: 500 }, burst: { siblingWindowMs: 1000 },
    topics: { ...DEFAULTS.topics, ...TEST_TOPICS, ...topics },
  };
  const realStore = createMessageStore({ db, config });
  // The SQL sample comes back in random order; sorting it makes the clustering, which is seeded, repeatable.
  const messageStore = {
    ...realStore,
    topicSample: (options) => realStore.topicSample(options).sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
  const topicStore = createTopicStore({ db });
  insertRows(messageStore, rows);
  const vectorStore = createFakeVectorStore(rows, { missing });
  const requests = [];
  const warnings = [];
  const chatClient = {
    complete: async (request) => {
      requests.push(request);
      const value = typeof answer === 'function' ? await answer(request, requests.length) : answer;
      if (value instanceof Error) throw value;
      return value;
    },
  };
  const builder = createTopicBuilder({
    messageStore, vectorStore, topicStore, chatClient, userDirectory: buildUserDirectory(users),
    random: seededRandom(seed), clock: { now: () => now }, config,
    logger: { info: () => {}, warn: (...args) => warnings.push(args) },
  });
  return { builder, db, topicStore, messageStore, vectorStore, requests, warnings, config };
};
