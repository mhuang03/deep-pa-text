import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookProvider } from '../../../src/discord/webhooks.js';
import { loadConfig } from '../../../src/config.js';
import { createFakeDiscord } from '../../support/fakes/discord.js';

const setup = () => {
  const { state } = createFakeDiscord();
  const provider = createWebhookProvider({ getBotUserId: () => 'bot-user', config: loadConfig({}) });
  return { channel: state.channel, other: state.otherChannel, provider };
};

test('creates the webhook with the configured name when none exists', async () => {
  const { channel, provider } = setup();
  const webhook = await provider.forChannel(channel);
  assert.equal(webhook.name, 'deep-pa-text');
  assert.deepEqual(channel.webhooks.creates, [{ name: 'deep-pa-text' }]);
});

test('reuses a bot-owned webhook with the configured name', async () => {
  const { channel, provider } = setup();
  const existing = channel.webhooks.add({ name: 'deep-pa-text' });
  assert.equal(await provider.forChannel(channel), existing);
  assert.deepEqual(channel.webhooks.creates, []);
});

test('ignores a webhook owned by someone else or with another name', async () => {
  const { channel, provider } = setup();
  channel.webhooks.add({ name: 'deep-pa-text', ownerId: 'someone' });
  channel.webhooks.add({ name: 'other' });
  const webhook = await provider.forChannel(channel);
  assert.equal(channel.webhooks.creates.length, 1);
  assert.equal(webhook.owner.id, 'bot-user');
});

test('caches the promise: concurrent and later calls share one lookup', async () => {
  const { channel, provider } = setup();
  const [a, b] = await Promise.all([provider.forChannel(channel), provider.forChannel(channel)]);
  assert.equal(a, b);
  await provider.forChannel(channel);
  assert.equal(channel.webhooks.creates.length, 1);
  assert.equal(channel.webhooks.fetches, 1);
});

test('caches per channel', async () => {
  const { channel, other, provider } = setup();
  await provider.forChannel(channel);
  await provider.forChannel(other);
  assert.equal(channel.webhooks.creates.length + other.webhooks.creates.length, 2);
});

test('a rejected lookup is evicted so the next call tries again', async () => {
  const { channel, provider } = setup();
  channel.webhooks.failCreate(new Error('missing permissions'));
  await assert.rejects(provider.forChannel(channel), /missing permissions/);
  const webhook = await provider.forChannel(channel);
  assert.equal(webhook.name, 'deep-pa-text');
});

test('forget evicts the cached webhook', async () => {
  const { channel, provider } = setup();
  await provider.forChannel(channel);
  provider.forget(channel);
  await provider.forChannel(channel);
  assert.equal(channel.webhooks.fetches, 2);
});

test('ownedIds lists every bot-owned webhook of the channel regardless of name', async () => {
  const { channel, provider } = setup();
  const a = channel.webhooks.add({ name: 'one' });
  const b = channel.webhooks.add({ name: 'two' });
  channel.webhooks.add({ name: 'three', ownerId: 'someone' });
  assert.deepEqual(await provider.ownedIds(channel), new Set([a.id, b.id]));
});

test('a channel without webhook support rejects', async () => {
  const { provider } = setup();
  const thread = { id: 't1' };
  await assert.rejects(provider.forChannel(thread), { message: 'channel does not support webhooks' });
  await assert.rejects(provider.ownedIds(thread), { message: 'channel does not support webhooks' });
});
