import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const HELLO = 'hello there friends';
const MINUTE = 60_000;
const MAX_ENTRY_CHARS = 300;
const RAISED_GIF_CAP = 12;
const EMBED_LIMIT = 10;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const TOKEN_URL = 'https://discord.com/api/v10/webhooks/1/SECRETTOKEN';

const newWorld = async (t, options = {}) => {
  const world = await createWorld({ random: 0, ...options });
  t.after(() => world.close());
  return world;
};

const webhookWorld = (t, options = {}) => newWorld(t, { ...options, env: { PERSONA_DISPLAY: 'webhook' } });
const hookSends = (world) => [...world.discord.channel.webhooks.list.values()].flatMap((hook) => hook.sent);
const userPrompt = (world) => world.llm.calls[0].messages.find((m) => m.role === 'user').content;
const allLogs = (world) => JSON.stringify([world.logs.log, world.logs.warn, world.logs.error]);

test('a masked link, a bare link and an invite are removed from an embed-mode reply', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith('check [free nitro](http://phish.example) now https://evil.example/x discord.gg/abc');
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies[0].content, 'check free nitro now');
  assert.equal(world.sqlite.get('SELECT content FROM bot_messages').content, 'check free nitro now');
});

test('links are removed from a webhook-mode reply too', async (t) => {
  const world = await webhookWorld(t);
  world.llm.respondWith('see [here](<https://evil.example>) www.evil.example ok');
  await world.emitMessage({ content: HELLO });
  assert.equal(hookSends(world)[0].content.split('\n').at(-1), 'see here  ok');
});

test('a reply that is only a link is empty output and sends nothing', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith('https://evil.example');
  const message = await world.emitMessage({ content: HELLO });
  assert.deepEqual(message.replies, []);
});

test('five GIF tokens resolve only two lookups and the rest are removed without a placeholder', async (t) => {
  const world = await newWorld(t);
  world.gifs.klipy.setResult('https://gif.example/a.gif');
  world.llm.respondWith('hi <gif! a> <gif! b> <gif! c> <gif! d> <gif! e>');
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(world.gifs.klipy.calls.length, 2);
  assert.equal(message.replies[0].content.includes('<gif!'), false);
  assert.equal(message.replies[0].content.includes('INSERT GIF'), false);
  assert.equal(message.replies[0].embeds.filter((e) => e.data.image).length, 2);
});

test('a raised GIF cap still never exceeds the embed limit, the author embed included', async (t) => {
  const world = await newWorld(t, { config: { gifs: { maxPerMessage: RAISED_GIF_CAP } } });
  world.gifs.klipy.setResult('https://gif.example/a.gif');
  const tokens = Array.from({ length: RAISED_GIF_CAP }, (_, i) => `<gif! q${i}>`).join(' ');
  world.llm.respondWith(`hi ${tokens}`);
  const message = await world.emitMessage({ content: HELLO });
  const { embeds } = message.replies[0];
  assert.equal(embeds.length, EMBED_LIMIT);
  assert.equal(embeds.filter((e) => e.data.image).length, EMBED_LIMIT - 1);
  assert.equal(embeds.at(-1).data.author.name.length > 0, true);
});

test('a failed webhook send logs no webhook token', async (t) => {
  const world = await webhookWorld(t);
  const hook = world.discord.channel.webhooks.add({ name: 'deep-pa-text' });
  hook.failSends(Object.assign(new Error('Unknown Webhook'), { url: TOKEN_URL, code: 10015 }));
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1, 'the embed form is the fallback');
  assert.ok(world.logs.warn.length >= 1);
  assert.equal(allLogs(world).includes('SECRETTOKEN'), false);
});

test('an API key inside an error message is redacted from the log', async (t) => {
  const world = await newWorld(t);
  world.gifs.klipy.setResult(new Error(`request failed: key=${world.env.KLIPY_API_KEY}`));
  await world.subject.processGIFs('hi <gif! cat>');
  const text = allLogs(world);
  assert.equal(text.includes(world.env.KLIPY_API_KEY), false);
  assert.match(text, /\[redacted\]/);
});

test('a transcript entry cut inside an emoji sends no lone surrogate to the LLM', async (t) => {
  const world = await newWorld(t);
  world.addHistory({
    author: 'alice', content: `${'a'.repeat(MAX_ENTRY_CHARS - 1)}\u{1F600}tail`, timestamp: BASE_TIME - 5 * MINUTE,
  });
  await world.emitMessage({ author: 'carol', content: 'want to get food' });
  const prompt = userPrompt(world);
  assert.ok(prompt.includes(`${'a'.repeat(MAX_ENTRY_CHARS - 1)}\u{1F600}…`));
  assert.equal(LONE_SURROGATE.test(prompt), false);
});

test('the error log of a failed auto reply names the message, the persona and the stage', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith(new Error('llm down'));
  const message = await world.emitMessage({ content: HELLO });
  const [label, detail] = world.logs.error[0];
  assert.match(label, new RegExp(`^Error processing message ${message.id} \\(auto reply as \\w+, stage generation\\):$`));
  assert.match(detail, /llm down/);
});

test('a failed send is logged with the delivery stage', async (t) => {
  const world = await newWorld(t);
  const message = world.discord.makeMessage({ content: HELLO });
  message.failReplies(new Error('Missing Permissions'));
  world.discord.client.emit(Events.MessageCreate, message);
  await world.settle();
  assert.match(world.logs.error[0][0], /\(auto reply as \w+, stage delivery\):$/);
});

test('a throwing transcript builder is a warning: the reply is still generated and sent without a transcript', async (t) => {
  const world = await newWorld(t);
  world.container.contextBuilder.forReply = async () => {
    throw new Error('transcript broke');
  };
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
  assert.equal(userPrompt(world).includes('recent conversation'), false);
  assert.equal(world.logs.warn.length, 1);
  assert.deepEqual(world.logs.error, []);
});
