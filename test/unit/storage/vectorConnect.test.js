import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectorConnection } from '../../../src/storage/vectorConnect.js';
import { isConfigError } from '../../../src/config/errors.js';

const guard = { timed: async (name, ms, work) => work(), limits: { connect: 10 } };
const setup = ({ stored = null, heartbeatError = null, dimensions = 4 } = {}) => {
  const calls = [];
  const connection = createVectorConnection({
    client: { heartbeat: async () => { calls.push('heartbeat'); if (heartbeatError) throw heartbeatError; } },
    config: { embedding: { dimensions } },
    guard,
    collections: async () => ({
      messages: { get: async () => ({ embeddings: stored === null ? [] : [new Array(stored).fill(0)] }) },
    }),
  });
  return { connection, calls };
};

test('connects when the collection is empty or has the configured dimension', async () => {
  await setup().connection.connect();
  await setup({ stored: 4 }).connection.connect();
});

test('checks the heartbeat first and propagates its failure', async () => {
  const { connection } = setup({ heartbeatError: new Error('down') });
  await assert.rejects(connection.connect(), /down/);
});

test('a stored dimension that differs from the configured one is a config error naming both', async () => {
  const { connection } = setup({ stored: 8, dimensions: 4 });
  await assert.rejects(connection.connect(), (error) => isConfigError(error) && /8-dimension.*dimensions is 4/.test(error.message));
});
