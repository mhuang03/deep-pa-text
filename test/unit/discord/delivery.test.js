import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import { createEmbedDelivery } from '../../../src/discord/delivery.js';
import { loadConfig } from '../../../src/config.js';

const AUTHOR = new EmbedBuilder().setAuthor({ name: 'bob' });

const setup = ({ env = {}, failSend = null } = {}) => {
  const sent = [];
  const makeCalls = [];
  const send = async (payload) => {
    if (failSend) throw failSend;
    sent.push(payload);
    return { id: 'sent-1' };
  };
  const authorEmbeds = { make: async (...args) => (makeCalls.push(args), AUTHOR) };
  const delivery = createEmbedDelivery({ authorEmbeds, config: loadConfig(env) });
  return { delivery, sent, makeCalls, send };
};

const request = (via) => ({
  via, persona: 'bob', guild: { id: 'g' }, content: 'hello', gifLinks: [{ match: 'm', url: 'https://x/a.gif' }],
});

test('a reply delivery replies to the message and returns the sent message', async () => {
  const { delivery, sent, makeCalls, send } = setup();
  const result = await delivery.deliver(request({ type: 'reply', message: { reply: send } }));
  assert.deepEqual(result, { id: 'sent-1' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'hello');
  assert.equal(sent[0].embeds.length, 2);
  assert.equal(sent[0].embeds.at(-1), AUTHOR);
  assert.deepEqual(makeCalls, [['bob', { id: 'g' }]]);
});

test('a reply carries repliedUser from config, true by default and false when disabled', async () => {
  const on = setup();
  await on.delivery.deliver(request({ type: 'reply', message: { reply: on.send } }));
  assert.deepEqual(on.sent[0].allowedMentions, { parse: [], repliedUser: true });
  const off = setup({ env: { PING_REPLIED_USER: 'false' } });
  await off.delivery.deliver(request({ type: 'reply', message: { reply: off.send } }));
  assert.deepEqual(off.sent[0].allowedMentions, { parse: [], repliedUser: false });
});

test('a channel delivery sends to the channel with safe mentions and no repliedUser', async () => {
  const { delivery, sent, send } = setup();
  await delivery.deliver(request({ type: 'channel', channel: { send } }));
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal('repliedUser' in sent[0].allowedMentions, false);
});

test('an interaction delivery edits the interaction reply with safe mentions', async () => {
  const { delivery, sent, send } = setup();
  const result = await delivery.deliver(request({ type: 'interaction', interaction: { editReply: send } }));
  assert.deepEqual(result, { id: 'sent-1' });
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('awaits the send before resolving', async () => {
  const { delivery } = setup();
  let finished = false;
  const channel = { send: async () => { await new Promise((r) => setImmediate(r)); finished = true; return {}; } };
  await delivery.deliver(request({ type: 'channel', channel }));
  assert.equal(finished, true);
});

test('propagates a rejected send', async () => {
  const boom = new Error('missing permissions');
  const { delivery, send } = setup({ failSend: boom });
  await assert.rejects(delivery.deliver(request({ type: 'channel', channel: { send } })), boom);
});

test('rejects an unknown delivery type without building an embed', async () => {
  const { delivery, makeCalls } = setup();
  await assert.rejects(delivery.deliver(request({ type: 'webhook' })), { message: 'unknown delivery type: webhook' });
  await assert.rejects(delivery.deliver(request({ type: 'toString' })), { message: 'unknown delivery type: toString' });
  assert.deepEqual(makeCalls, []);
});

test('a followUp delivery sends through interaction.followUp with safe mentions only', async () => {
  const { delivery, sent, send } = setup();
  const interaction = { followUp: send };
  const result = await delivery.deliver({
    via: { type: 'followUp', interaction }, persona: 'bob', guild: {}, content: 'two', gifLinks: [],
  });
  assert.deepEqual(result, { id: 'sent-1' });
  assert.equal(sent[0].content, 'two');
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});
