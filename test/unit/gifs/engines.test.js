import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGiphyEngine, createHumorEngine, createKlipyEngine } from '../../../src/gifs/engines.js';
import { loadConfig } from '../../../src/config.js';
import { createFakeGifs } from '../../support/fakes/gifs.js';

const config = loadConfig({ KLIPY_API_KEY: 'kk', HUMOR_API_KEY: 'hh', GIPHY_API_KEY: 'gg' });
const urls = (n) => Array.from({ length: n }, (_, i) => `https://gifs.example/${i}.gif`);

const klipy = () => {
  const fakes = createFakeGifs();
  return { ...fakes, engine: createKlipyEngine({ fetch: fakes.fetch, config }), fake: fakes.state.klipy };
};
const humor = () => {
  const fakes = createFakeGifs();
  return { ...fakes, engine: createHumorEngine({ fetch: fakes.fetch, config }), fake: fakes.state.humor };
};
const giphy = () => {
  const fakes = createFakeGifs();
  const engine = createGiphyEngine({ giphy: new fakes.GiphyFetch('gg'), config });
  return { ...fakes, engine, fake: fakes.state.giphy };
};
const ENGINES = { klipy, giphy, humor };

test('engines name themselves', () => {
  assert.deepEqual([klipy(), giphy(), humor()].map((e) => e.engine.name), ['klipy', 'giphy', 'humor']);
});

test('klipy sends the legacy request and returns the urls', async () => {
  const { engine, fake } = klipy();
  fake.setResult(['https://k/x.gif', 'https://k/y.gif']);
  assert.deepEqual(await engine.search('funny cat'), ['https://k/x.gif', 'https://k/y.gif']);
  const [url] = fake.calls;
  assert.equal(url.hostname, 'api.klipy.com');
  assert.equal(url.pathname, '/api/v1/kk/gifs/search');
  assert.deepEqual([...url.searchParams.entries()], [
    ['page', '1'], ['per_page', '8'], ['q', 'funny cat'], ['customer_id', 'deep-pa-text'],
    ['locale', 'us'], ['content_filter', 'off'], ['format_filter', 'gif'],
  ]);
});

test('humor sends the request with number=candidates', async () => {
  const { engine, fake } = humor();
  fake.setResult('https://h/x.gif');
  assert.deepEqual(await engine.search('wow'), ['https://h/x.gif']);
  const [url] = fake.calls;
  assert.equal(url.hostname, 'api.humorapi.com');
  assert.equal(url.pathname, '/gif/search');
  assert.deepEqual([...url.searchParams.entries()], [['api-key', 'hh'], ['number', '5'], ['query', 'wow']]);
});

test('giphy searches with limit=candidates and reads the original url', async () => {
  const { engine, fake } = giphy();
  fake.setResult('https://g/x.gif');
  assert.deepEqual(await engine.search('cat'), ['https://g/x.gif']);
  assert.deepEqual(fake.calls, [['cat', { limit: 5 }]]);
});

for (const [name, make] of Object.entries(ENGINES)) {
  test(`${name} returns an empty array for no result`, async () => {
    assert.deepEqual(await make().engine.search('q'), []);
  });

  test(`${name} caps results at the candidate count`, async () => {
    const { engine, fake } = make();
    fake.setResult(urls(8));
    assert.deepEqual(await engine.search('q'), urls(5));
  });

  test(`${name} removes duplicates and non-http urls`, async () => {
    const { engine, fake } = make();
    fake.setResult(['https://a/1.gif', 'https://a/1.gif', 'ftp://a/2.gif', 'not a url', 'http://a/3.gif']);
    assert.deepEqual(await engine.search('q'), ['https://a/1.gif', 'http://a/3.gif']);
  });

  test(`${name} propagates an error`, async () => {
    const { engine, fake } = make();
    fake.setResult(new Error('boom'));
    await assert.rejects(engine.search('q'), { message: 'boom' });
  });
}

const MALFORMED = {
  klipy: [{}, { data: {} }, { data: { data: 'x' } }, { data: { data: [{}, { file: {} }, null] } }, null],
  humor: [{}, { images: null }, { images: [{}, null, { url: 5 }] }],
};

for (const [name, bodies] of Object.entries(MALFORMED)) {
  test(`${name} yields no urls for a malformed body`, async () => {
    for (const body of bodies) {
      const { engine, fake } = ENGINES[name]();
      fake.setResult({ body });
      assert.deepEqual(await engine.search('q'), [], JSON.stringify(body));
    }
  });
}

test('giphy yields no urls for a malformed result', async () => {
  for (const result of [{}, { data: null }, { data: [{}, { images: {} }] }, null]) {
    const engine = createGiphyEngine({ giphy: { search: async () => result }, config });
    assert.deepEqual(await engine.search('q'), []);
  }
});

for (const name of ['klipy', 'humor']) {
  test(`${name} treats a non-OK status as an error without the request url`, async () => {
    const { engine, fake } = ENGINES[name]();
    fake.setResult({ status: 500 });
    await assert.rejects(engine.search('q'), (error) => {
      assert.equal(error.message, `${name} responded 500`);
      assert.equal(error.message.includes('kk'), false);
      return true;
    });
  });
}

test('an absent ok flag is treated as success', async () => {
  const fetch = async () => ({ json: async () => ({ images: [{ url: 'https://h/a.gif' }] }) });
  assert.deepEqual(await createHumorEngine({ fetch, config }).search('q'), ['https://h/a.gif']);
});
