import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStorage } from '../../../src/container/storage.js';
import { openDatabase } from '../../../src/storage/database.js';
import { createMetaStore } from '../../../src/storage/metaStore.js';
import { makeParts } from '../../support/containerParts.js';

test('returns the stores, the filter and the user directory over one open database', () => {
  const parts = makeParts();
  const storage = buildStorage(parts);
  assert.deepEqual(Object.keys(storage).sort(), [
    'botMessageStore', 'conversationStore', 'db', 'messageFilter', 'messageStore', 'metaStore', 'profileStore', 'userDirectory', 'vectorStore',
  ]);
  assert.equal(storage.userDirectory.nameOf('alice'), 'Alice Example');
  storage.db.close();
});

test('constructs the Chroma client with the configured port and the embedding function with its options', () => {
  const parts = makeParts({ CHROMA_PORT: '9100' });
  const storage = buildStorage(parts);
  assert.deepEqual(parts.fakes.chroma.state.constructed, [{ port: 9100 }]);
  assert.equal(parts.fakes.chroma.state.embeddingFunctionOptions.modelName, parts.config.embedding.modelName);
  storage.db.close();
});

test('the vector store follows the generation stored in the database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-storage-'));
  const databasePath = path.join(dir, 'messages.db');
  const seeded = openDatabase(databasePath);
  createMetaStore({ db: seeded }).setIfAbsent('chroma_generation', 'g1');
  seeded.close();
  const parts = makeParts();
  const storage = buildStorage({ ...parts, config: { ...parts.config, storage: { ...parts.config.storage, databasePath } } });
  await storage.vectorStore.connect();
  assert.equal(parts.fakes.chroma.state.collection('message_embeddings_g1').name, 'message_embeddings_g1');
  storage.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
