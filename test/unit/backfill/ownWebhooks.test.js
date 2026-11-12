import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOwnWebhookIds } from '../../../src/backfill/ownWebhooks.js';

test('returns the ids the provider reports', async () => {
  const webhooks = { ownedIds: async (channel) => new Set([`${channel.id}-hook`]) };
  const ids = await listOwnWebhookIds({ webhooks, logger: { warn: () => {} } }, { id: 'c1' });
  assert.deepEqual([...ids], ['c1-hook']);
});

test('falls back to an empty set and logs a warning when the lookup fails', async () => {
  const warnings = [];
  const webhooks = { ownedIds: async () => { throw new Error('Missing Permissions'); } };
  const ids = await listOwnWebhookIds({ webhooks, logger: { warn: (...args) => warnings.push(args) } }, { id: 'c1' });
  assert.equal(ids.size, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /Could not list the bot webhooks/);
  assert.equal(warnings[0][1].message, 'Missing Permissions');
});
