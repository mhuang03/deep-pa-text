import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createWebhookDelivery, REPLY_LINK_PREFIX } from '../../../src/discord/webhookDelivery.js';
import { loadConfig } from '../../../src/config.js';

const GIFS = [{ match: 'm', url: 'https://x/a.gif' }, { match: 'n', url: null }];

const setup = ({ env = {}, profile = {}, sendError = null, lookupError = null } = {}) => {
  const events = [];
  const warnings = [];
  const errors = [];
  const webhook = {
    send: async (payload) => {
      events.push(['send', payload]);
      if (sendError) throw sendError;
      return { id: 'wh-msg' };
    },
  };
  const webhooks = {
    forChannel: async (channel) => {
      events.push(['forChannel', channel.id]);
      if (lookupError) throw lookupError;
      return webhook;
    },
    forget: (channel) => events.push(['forget', channel.id]),
  };
  const memberProfiles = {
    current: async (persona) => ({
      username: persona, userId: 'u', displayName: 'Bobbo', avatarURL: 'https://a/b.png', ...profile,
    }),
  };
  const fallback = { deliver: async (request) => (events.push(['fallback', request]), { id: 'fb-msg' }) };
  const config = loadConfig(env);
  const delivery = createWebhookDelivery({
    webhooks, memberProfiles, fallback, config,
    logger: { warn: (...a) => warnings.push(a), error: (...a) => errors.push(a) },
  });
  return { delivery, events, warnings, errors };
};

const CHANNEL = { id: 'c1' };
const request = (via, extra = {}) => ({
  via, persona: 'bob', guild: { id: 'g' }, channel: CHANNEL, content: 'hello', gifLinks: GIFS, ...extra,
});
const REPLY = { type: 'reply', message: { url: 'https://discord.test/m/1' } };
const sentPayload = (events) => events.find(([name]) => name === 'send')[1];

test('sends through the webhook with the member name, avatar, GIF embeds only and safe mentions', async () => {
  const { delivery, events } = setup();
  const message = await delivery.deliver(request({ type: 'channel', channel: CHANNEL }));
  assert.deepEqual(message, { id: 'wh-msg' });
  const payload = sentPayload(events);
  assert.equal(payload.content, 'hello');
  assert.equal(payload.username, 'Bobbo');
  assert.equal(payload.avatarURL, 'https://a/b.png');
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].data.image.url, 'https://x/a.gif');
  assert.equal(events.some(([name]) => name === 'fallback'), false);
});

test('a missing avatar is sent as undefined', async () => {
  const { delivery, events } = setup({ profile: { avatarURL: null } });
  await delivery.deliver(request({ type: 'channel', channel: CHANNEL }));
  assert.equal(sentPayload(events).avatarURL, undefined);
});

test('a reply gets the jump-link line above the content', async () => {
  const { delivery, events } = setup();
  await delivery.deliver(request(REPLY));
  assert.equal(sentPayload(events).content, `${REPLY_LINK_PREFIX}https://discord.test/m/1\nhello`);
  assert.equal(REPLY_LINK_PREFIX, '-# ↪ ');
});

test('the reply link is omitted when webhookReplyLink is off or the via is not a reply', async () => {
  const { delivery, events } = setup();
  await delivery.deliver(request({ type: 'followUp', interaction: { editReply: async () => {} } }));
  assert.equal(sentPayload(events).content, 'hello');
  const config = loadConfig({});
  const off = createWebhookDelivery({
    webhooks: { forChannel: async () => ({ send: async (p) => (events.push(['send', p]), {}) }), forget: () => {} },
    memberProfiles: { current: async () => ({ displayName: 'B', avatarURL: null }) },
    fallback: {}, logger: {},
    config: { ...config, discord: { ...config.discord, webhookReplyLink: false } },
  });
  events.length = 0;
  await off.deliver(request(REPLY));
  assert.equal(sentPayload(events).content, 'hello');
});

test('the combined text is truncated again to the Discord limit', async () => {
  const { delivery, events } = setup();
  await delivery.deliver(request(REPLY, { content: 'word '.repeat(500).trim() }));
  const { content } = sentPayload(events);
  assert.ok(content.length <= 2000);
  assert.ok(content.startsWith(REPLY_LINK_PREFIX));
});

test('an interaction delivery edits the placeholder after the persona message', async () => {
  const { delivery, events } = setup();
  const interaction = { editReply: async (p) => events.push(['edit', p]) };
  await delivery.deliver(request({ type: 'interaction', interaction }));
  assert.deepEqual(events.map(([name]) => name), ['forChannel', 'send', 'edit']);
  assert.deepEqual(events.at(-1)[1], { content: 'Sent as bob.', allowedMentions: { parse: [] } });
});

test('a followUp delivery sends the persona message only', async () => {
  const { delivery, events } = setup();
  const interaction = { editReply: async () => events.push(['edit']) };
  await delivery.deliver(request({ type: 'followUp', interaction }));
  assert.deepEqual(events.map(([name]) => name), ['forChannel', 'send']);
});

test('an unusable name falls back without touching the webhook provider', async () => {
  const { delivery, events } = setup({ profile: { displayName: 'Discord Dan' } });
  const real = { ...request({ type: 'channel', channel: CHANNEL }), persona: 'discorddan' };
  await delivery.deliver(real);
  assert.deepEqual(events.map(([name]) => name), ['fallback']);
});

test('the username replaces a forbidden display name', async () => {
  const { delivery, events } = setup({ profile: { displayName: 'Clyde' } });
  await delivery.deliver(request({ type: 'channel', channel: CHANNEL }));
  assert.equal(sentPayload(events).username, 'bob');
});

test('a failed lookup forgets the channel, warns and falls back', async () => {
  const { delivery, events, warnings } = setup({ lookupError: new Error('no permission') });
  const message = await delivery.deliver(request(REPLY));
  assert.deepEqual(message, { id: 'fb-msg' });
  assert.deepEqual(events.map(([name]) => name), ['forChannel', 'forget', 'fallback']);
  assert.equal(events.at(-1)[1].via, REPLY);
  assert.equal(warnings.length, 1);
});

test('the warning is logged once per channel and error message', async () => {
  const { delivery, warnings } = setup({ lookupError: new Error('no permission') });
  const via = { type: 'channel', channel: CHANNEL };
  await delivery.deliver(request(via));
  await delivery.deliver(request(via));
  assert.equal(warnings.length, 1);
  const other = { ...request(via), channel: { id: 'c2' } };
  await delivery.deliver(other);
  assert.equal(warnings.length, 2);
});

test('a send rejected with code 10015 or status 404 forgets the webhook and falls back', async () => {
  for (const error of [Object.assign(new Error('Unknown Webhook'), { code: 10015 }), Object.assign(new Error('nf'), { status: 404 })]) {
    const { delivery, events } = setup({ sendError: error });
    await delivery.deliver(request({ type: 'channel', channel: CHANNEL }));
    assert.deepEqual(events.map(([name]) => name), ['forChannel', 'send', 'forget', 'fallback']);
  }
});

test('any other send failure falls back and keeps the cached webhook', async () => {
  const { delivery, events } = setup({ sendError: Object.assign(new Error('invalid body'), { code: 50035 }) });
  await delivery.deliver(request({ type: 'channel', channel: CHANNEL }));
  assert.deepEqual(events.map(([name]) => name), ['forChannel', 'send', 'fallback']);
});

test('the fallback for an interaction goes to the channel, and the placeholder is still edited', async () => {
  const { delivery, events } = setup({ lookupError: new Error('no permission') });
  const interaction = { editReply: async (p) => events.push(['edit', p]) };
  await delivery.deliver(request({ type: 'interaction', interaction }));
  const fallbackCall = events.find(([name]) => name === 'fallback')[1];
  assert.deepEqual(fallbackCall.via, { type: 'channel', channel: CHANNEL });
  assert.equal(events.at(-1)[0], 'edit');
});

test('the fallback for a followUp also goes to the channel', async () => {
  const { delivery, events } = setup({ lookupError: new Error('x') });
  await delivery.deliver(request({ type: 'followUp', interaction: {} }));
  assert.deepEqual(events.find(([name]) => name === 'fallback')[1].via, { type: 'channel', channel: CHANNEL });
});

test('a failed placeholder edit is logged and the sent message is still returned', async () => {
  const { delivery, errors } = setup();
  const interaction = { editReply: async () => { throw new Error('token expired'); } };
  const message = await delivery.deliver(request({ type: 'interaction', interaction }));
  assert.deepEqual(message, { id: 'wh-msg' });
  assert.equal(errors.length, 1);
});

test('a failing fallback propagates', async () => {
  const boom = new Error('both down');
  const { delivery } = setup({ lookupError: new Error('x') });
  const failing = createWebhookDelivery({
    webhooks: { forChannel: async () => { throw new Error('x'); }, forget: () => {} },
    memberProfiles: { current: async () => ({ displayName: 'B', avatarURL: null }) },
    fallback: { deliver: async () => { throw boom; } },
    config: loadConfig({}), logger: { warn: () => {} },
  });
  await assert.rejects(failing.deliver(request({ type: 'channel', channel: CHANNEL })), boom);
  assert.ok(delivery);
});

test('placeholder is an ephemeral notice with safe mentions', async () => {
  const { delivery } = setup();
  assert.deepEqual(await delivery.placeholder({ persona: 'bob', guild: {} }), {
    content: 'Replying as bob…', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
  });
});
