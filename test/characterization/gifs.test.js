import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';

const newWorld = async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  return world;
};

const URL_K = 'https://gifs.example/klipy.gif';
const URL_G = 'https://gifs.example/giphy.gif';
const URL_H = 'https://gifs.example/humor.gif';

const callCounts = (world) => [world.gifs.klipy.calls.length, world.gifs.giphy.calls.length, world.gifs.humor.calls.length];
const bySet = (links) => [...links].sort((a, b) => a.match.localeCompare(b.match));

test('without a gif token returns the text unchanged and calls no engine', async (t) => {
  const world = await newWorld(t);
  const result = await world.subject.processGIFs('no gifs here');
  assert.deepEqual(result, { content: 'no gifs here', gifLinks: [] });
  assert.deepEqual(callCounts(world), [0, 0, 0]);
});

test('uses Klipy when it has a result and does not call Giphy or Humor', async (t) => {
  const world = await newWorld(t);
  world.gifs.klipy.setResult(URL_K);
  const result = await world.subject.processGIFs('yo <gif! funny cat>');
  assert.equal(result.content, 'yo ');
  assert.deepEqual(result.gifLinks, [{ match: '<gif! funny cat>', url: URL_K }]);
  assert.deepEqual(callCounts(world), [1, 0, 0]);
});

test('falls back to Giphy when Klipy is empty and does not call Humor', async (t) => {
  const world = await newWorld(t);
  world.gifs.giphy.setResult(URL_G);
  const result = await world.subject.processGIFs('yo <gif! funny cat>');
  assert.deepEqual(result.gifLinks, [{ match: '<gif! funny cat>', url: URL_G }]);
  assert.equal(result.content, 'yo ');
  assert.deepEqual(callCounts(world), [1, 1, 0]);
});

test('falls back to Humor when Klipy and Giphy are empty', async (t) => {
  const world = await newWorld(t);
  world.gifs.humor.setResult(URL_H);
  const result = await world.subject.processGIFs('yo <gif! funny cat>');
  assert.deepEqual(result.gifLinks, [{ match: '<gif! funny cat>', url: URL_H }]);
  assert.equal(result.content, 'yo ');
  assert.deepEqual(callCounts(world), [1, 1, 1]);
});

test('when every engine is empty leaves an INSERT GIF placeholder and an empty url', async (t) => {
  const world = await newWorld(t);
  const result = await world.subject.processGIFs('yo <gif! funny cat>');
  assert.equal(result.content, 'yo <INSERT GIF:  funny cat>');
  assert.deepEqual(result.gifLinks, [{ match: '<gif! funny cat>', url: '' }]);
});

test('an unresolved token without a space becomes <INSERT GIF: cat>', async (t) => {
  const world = await newWorld(t);
  const result = await world.subject.processGIFs('<gif!cat>');
  assert.equal(result.content, '<INSERT GIF: cat>');
});

test('two resolved tokens are both removed and both reported', async (t) => {
  const world = await newWorld(t);
  world.gifs.klipy.setResult((q) => (q === 'cat' ? URL_K : URL_G));
  const result = await world.subject.processGIFs('a <gif! cat> b <gif! dog> c');
  assert.equal(result.content, 'a  b  c');
  assert.deepEqual(bySet(result.gifLinks), [
    { match: '<gif! cat>', url: URL_K },
    { match: '<gif! dog>', url: URL_G },
  ]);
});

test('a resolved and an unresolved token in one text are handled independently', async (t) => {
  const world = await newWorld(t);
  world.gifs.klipy.setResult((q) => (q === 'cat' ? URL_K : null));
  const result = await world.subject.processGIFs('a <gif! cat> b <gif! dog> c');
  assert.equal(result.content, 'a  b <INSERT GIF:  dog> c');
  assert.deepEqual(bySet(result.gifLinks), [
    { match: '<gif! cat>', url: URL_K },
    { match: '<gif! dog>', url: '' },
  ]);
});

test('search text is trimmed then cut to 50 characters for every engine', async (t) => {
  const world = await newWorld(t);
  const term = 'a'.repeat(60);
  await world.subject.processGIFs(`<gif!   ${term}  >`);
  const expected = 'a'.repeat(50);
  assert.equal(world.gifs.klipy.calls[0].searchParams.get('q'), expected);
  assert.equal(world.gifs.giphy.calls[0][0], expected);
  assert.equal(world.gifs.humor.calls[0].searchParams.get('query'), expected);
});

test('Klipy request has the pinned host, path and query', async (t) => {
  const world = await newWorld(t);
  await world.subject.processGIFs('<gif! funny cat>');
  const url = world.gifs.klipy.calls[0];
  assert.equal(url.hostname, 'api.klipy.com');
  assert.equal(url.pathname, `/api/v1/${world.env.KLIPY_API_KEY}/gifs/search`);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    page: '1',
    per_page: '8',
    q: 'funny cat',
    customer_id: 'deep-pa-text',
    locale: 'us',
    content_filter: 'off',
    format_filter: 'gif',
  });
});

test('Humor request has the pinned host, path and query', async (t) => {
  const world = await newWorld(t);
  await world.subject.processGIFs('<gif! funny cat>');
  const url = world.gifs.humor.calls[0];
  assert.equal(url.hostname, 'api.humorapi.com');
  assert.equal(url.pathname, '/gif/search');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    'api-key': world.env.HUMOR_API_KEY,
    number: '1',
    query: 'funny cat',
  });
});

test('Giphy is called with the term and { limit: 1 }', async (t) => {
  const world = await newWorld(t);
  await world.subject.processGIFs('<gif! funny cat>');
  assert.deepEqual(world.gifs.giphy.calls, [['funny cat', { limit: 1 }]]);
});

for (const engine of ['klipy', 'giphy', 'humor']) {
  test(`KNOWN BUG (spec 13): processGIFs rejects when ${engine} throws`, async (t) => {
    const world = await newWorld(t);
    const boom = new Error(`${engine} down`);
    world.gifs[engine].setResult(boom);
    await assert.rejects(world.subject.processGIFs('<gif! funny cat>'), boom);
  });
}
