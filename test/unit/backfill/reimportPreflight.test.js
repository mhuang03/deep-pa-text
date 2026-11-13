import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../../../src/backfill/reimportPreflight.js';

const DIMENSIONS = 4;
const config = {
  chroma: { port: 7429, connectTimeoutMs: 50, timeoutMs: 50 },
  embedding: { apiKeyEnvVar: 'OPENAI_API_KEY', modelName: 'm', dimensions: DIMENSIONS },
};

const build = ({ heartbeat = async () => 1, generate = async () => [Array(DIMENSIONS).fill(0)], access = () => {} } = {}) => {
  const seen = { chroma: null, embedding: null, accessed: [], order: [] };
  const vendor = {
    ChromaClient: class {
      constructor(options) { seen.chroma = options; }
      heartbeat() { seen.order.push('chroma'); return heartbeat(); }
    },
    OpenAIEmbeddingFunction: class {
      constructor(options) { seen.embedding = options; }
      generate(texts) { seen.order.push('embedding'); return generate(texts); }
    },
  };
  const fs = {
    constants: { R_OK: 4, W_OK: 2 },
    accessSync: (dir, mode) => { seen.order.push('directory'); seen.accessed.push({ dir, mode }); access(dir); },
  };
  const clock = { setTimeout, clearTimeout };
  return { ctx: { config, vendor, fs, clock, dbPath: '/somewhere/messages.db' }, seen };
};

test('passes when Chroma answers, an embedding of the configured size comes back and the directory is writable', async () => {
  const { ctx, seen } = build();
  await preflight(ctx);
  assert.deepEqual(seen.chroma, { port: 7429 });
  assert.deepEqual(seen.embedding, { apiKeyEnvVar: 'OPENAI_API_KEY', modelName: 'm', dimensions: DIMENSIONS });
  assert.deepEqual(seen.accessed, [{ dir: '/somewhere', mode: 6 }]);
  assert.deepEqual(seen.order.sort(), ['chroma', 'directory', 'embedding']);
});

test('an unreachable Chroma fails, naming the port and saying nothing was fetched', async () => {
  const { ctx } = build({ heartbeat: async () => { throw new Error('connect ECONNREFUSED'); } });
  await assert.rejects(preflight(ctx), (error) => {
    assert.match(error.message, /nothing was fetched or changed/i);
    assert.match(error.message, /Chroma on port 7429: connect ECONNREFUSED/);
    return true;
  });
});

test('a Chroma that hangs fails after the connect timeout', async () => {
  const { ctx } = build({ heartbeat: () => new Promise(() => {}) });
  await assert.rejects(preflight(ctx), /Chroma on port 7429: .*timed out after 50 ms/);
});

test('a rejected embedding request fails, naming the key variable', async () => {
  const { ctx } = build({ generate: async () => { throw new Error('401 bad key'); } });
  await assert.rejects(preflight(ctx), /Embedding API \(OPENAI_API_KEY\): 401 bad key/);
});

test('an embedding of the wrong size fails', async () => {
  const { ctx } = build({ generate: async () => [[1, 2]] });
  await assert.rejects(preflight(ctx), /Embedding API \(OPENAI_API_KEY\): expected 4 dimensions, got 2/);
});

test('a directory that cannot be written fails', async () => {
  const { ctx } = build({ access: () => { throw new Error('EACCES: permission denied'); } });
  await assert.rejects(preflight(ctx), /Database directory \/somewhere: EACCES/);
});

test('every failing check is reported in one error', async () => {
  const { ctx } = build({
    heartbeat: async () => { throw new Error('down'); },
    generate: async () => { throw new Error('quota'); },
  });
  await assert.rejects(preflight(ctx), (error) => {
    assert.match(error.message, /Chroma on port 7429: down/);
    assert.match(error.message, /Embedding API \(OPENAI_API_KEY\): quota/);
    return true;
  });
});
