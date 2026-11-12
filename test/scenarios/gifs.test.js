import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { createWorld } from '../support/world.js';

// Mirrors the characterization auto-reply setup; see test/characterization/auto-reply.test.js.
const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const HELLO = 'hello there friends';
const YIELDS = 10;

// world.emitMessage waits for the bot to go quiet, which never happens while an engine hangs.
const emitWithoutSettling = async (world, fields) => {
  const message = world.discord.makeMessage(fields);
  world.discord.client.emit(Events.MessageCreate, message);
  for (let i = 0; i < YIELDS; i += 1) await new Promise((resolve) => setImmediate(resolve));
  return message;
};

test('processGIFs picks among candidates using the roll', async (t) => {
  const world = await newWorld(t);
  world.gifs.klipy.setResult(['https://g.example/0.gif', 'https://g.example/1.gif', 'https://g.example/2.gif']);
  world.setRandom(0);
  const first = await world.subject.processGIFs('<gif! cat>');
  world.setRandom(0.99);
  const last = await world.subject.processGIFs('<gif! cat>');
  assert.equal(first.gifLinks[0].url, 'https://g.example/0.gif');
  assert.equal(last.gifLinks[0].url, 'https://g.example/2.gif');
});

test('processGIFs survives every engine throwing and logs warnings without the api key', async (t) => {
  const world = await newWorld(t);
  for (const name of ['klipy', 'giphy', 'humor']) world.gifs[name].setResult(new Error(`${name} down`));
  const result = await world.subject.processGIFs('hi <gif! cat>');
  assert.equal(result.content, 'hi <INSERT GIF:  cat>');
  const warnings = world.logs.warn.map((args) => args.join(' '));
  assert.equal(warnings.length, 3);
  assert.equal(warnings.some((w) => w.includes(world.env.KLIPY_API_KEY)), false);
});

test('a Klipy HTTP 500 falls through to Giphy', async (t) => {
  const world = await newWorld(t);
  world.gifs.klipy.setResult({ status: 500 });
  world.gifs.giphy.setResult('https://g.example/g.gif');
  const result = await world.subject.processGIFs('<gif! cat>');
  assert.equal(result.gifLinks[0].url, 'https://g.example/g.gif');
});

test('a hanging engine is abandoned after the timeout and the next engine is used', async (t) => {
  const world = await newWorld(t);
  world.gifs.klipy.setResult({ hang: true });
  world.gifs.giphy.setResult('https://g.example/g.gif');
  let result = null;
  const pending = world.subject.processGIFs('<gif! cat>').then((r) => {
    result = r;
  });
  assert.equal(result, null);
  await world.advance(5000);
  await pending;
  assert.equal(result.gifLinks[0].url, 'https://g.example/g.gif');
  assert.equal(world.logs.warn.length, 1);
});

test('an auto reply is still delivered, with a placeholder, when every engine throws', async (t) => {
  const world = await newWorld(t, { random: 0 });
  for (const name of ['klipy', 'giphy', 'humor']) world.gifs[name].setResult(new Error(`${name} down`));
  world.llm.respondWith('lol <gif! cat>');
  const message = await world.emitMessage({ content: HELLO });
  assert.equal(message.replies.length, 1);
  assert.equal(message.replies[0].content, 'lol <INSERT GIF:  cat>');
});

test('a hanging engine does not block the auto reply beyond the timeout', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.gifs.klipy.setResult({ hang: true });
  world.gifs.giphy.setResult('https://g.example/g.gif');
  world.llm.respondWith('lol <gif! cat>');
  const message = await emitWithoutSettling(world, { content: HELLO });
  assert.equal(message.replies.length, 0);
  await world.advance(5000);
  assert.equal(message.replies.length, 1);
  assert.equal(message.replies[0].content, 'lol ');
  assert.equal(message.replies[0].embeds.some((e) => e.data.image?.url === 'https://g.example/g.gif'), true);
});
