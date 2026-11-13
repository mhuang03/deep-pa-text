import { buildUserDirectory } from '../userData/loadData.js';
import { createMessageFilter } from '../corpus/messageFilter.js';
import { openDatabase } from '../storage/database.js';
import { createMessageStore } from '../storage/messageStore.js';
import { createBotMessageStore } from '../storage/botMessageStore.js';
import { createConversationStore } from '../storage/conversationStore.js';
import { createProfileStore } from '../storage/profileStore.js';
import { createMetaStore } from '../storage/metaStore.js';
import { createVectorStore } from '../storage/vectorStore.js';
import { GENERATION_KEY } from '../backfill/switchState.js';

const buildVectorStore = ({ config, vendor, generation, clock }) => {
  const { chroma, embedding } = config;
  const client = new vendor.ChromaClient({ port: chroma.port });
  const embeddingFunction = new vendor.OpenAIEmbeddingFunction({
    apiKeyEnvVar: embedding.apiKeyEnvVar,
    modelName: embedding.modelName,
    dimensions: embedding.dimensions,
  });
  return createVectorStore({ client, embeddingFunction, config, generation, clock });
};

// The databases, vector store and the pure data derived from the user files.
export const buildStorage = ({ config, vendor, data, clock }) => {
  const db = openDatabase(config.storage.databasePath, { busyTimeoutMs: config.storage.busyTimeoutMs });
  const messageStore = createMessageStore({ db, config });
  const botMessageStore = createBotMessageStore({ db, config });
  const conversationStore = createConversationStore({ db });
  const profileStore = createProfileStore({ db });
  const metaStore = createMetaStore({ db });
  const vectorStore = buildVectorStore({ config, vendor, generation: metaStore.get(GENERATION_KEY), clock });
  const messageFilter = createMessageFilter({ users: data.users, pingCache: data.pingCache, config });
  const userDirectory = buildUserDirectory(data.users);
  return { db, messageStore, botMessageStore, conversationStore, profileStore, metaStore, vectorStore, messageFilter, userDirectory };
};
