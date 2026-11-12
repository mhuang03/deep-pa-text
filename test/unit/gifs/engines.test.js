import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGiphyEngine, createHumorEngine, createKlipyEngine } from '../../../src/gifs/engines.js';
import { loadConfig } from '../../../src/config.js';
import { createFakeGifs } from '../../support/fakes/gifs.js';

const config = loadConfig({ KLIPY_API_KEY: 'kk', HUMOR_API_KEY: 'hh', GIPHY_API_KEY: 'gg' });

test('klipy sends the legacy request', async () => {
  const { fetch, state } = createFakeGifs();
  state.klipy.setResult('https://k/x.gif');
  const engine = createKlipyEngine({ fetch, config });
  assert.equal(await engine.search('funny cat'), 'https://k/x.gif');
  const [url] = state.klipy.calls;
  assert.equal(url.hostname, 'api.klipy.com');
  assert.equal(url.pathname, '/api/v1/kk/gifs/search');
  assert.deepEqual([...url.searchParams.entries()], [
    ['page', '1'], ['per_page', '8'], ['q', 'funny cat'], ['customer_id', 'deep-pa-text'],
    ['locale', 'us'], ['content_filter', 'off'], ['format_filter', 'gif'],
  ]);
});

test('klipy returns an empty string for no result or a missing data envelope', async () => {
  const { fetch } = createFakeGifs();
  assert.equal(await createKlipyEngine({ fetch, config }).search('q'), '');
  const empty = async () => ({ json: async () => ({}) });
  assert.equal(await createKlipyEngine({ fetch: empty, config }).search('q'), '');
});

test('klipy and humor name themselves', () => {
  const { fetch } = createFakeGifs();
  assert.equal(createKlipyEngine({ fetch, config }).name, 'klipy');
  assert.equal(createHumorEngine({ fetch, config }).name, 'humor');
  assert.equal(createGiphyEngine({ giphy: {} }).name, 'giphy');
});

test('klipy propagates a fetch failure', async () => {
  const fetch = async () => {
    throw new Error('boom');
  };
  await assert.rejects(createKlipyEngine({ fetch, config }).search('q'), { message: 'boom' });
});

test('humor sends the legacy request', async () => {
  const { fetch, state } = createFakeGifs();
  state.humor.setResult('https://h/x.gif');
  assert.equal(await createHumorEngine({ fetch, config }).search('wow'), 'https://h/x.gif');
  const [url] = state.humor.calls;
  assert.equal(url.hostname, 'api.humorapi.com');
  assert.equal(url.pathname, '/gif/search');
  assert.deepEqual([...url.searchParams.entries()], [['api-key', 'hh'], ['number', '1'], ['query', 'wow']]);
});

test('humor returns an empty string for no result', async () => {
  const { fetch } = createFakeGifs();
  assert.equal(await createHumorEngine({ fetch, config }).search('q'), '');
});

test('giphy searches with limit 1 and reads the original url', async () => {
  const { GiphyFetch, state } = createFakeGifs();
  state.giphy.setResult('https://g/x.gif');
  const engine = createGiphyEngine({ giphy: new GiphyFetch('gg'), config });
  assert.equal(await engine.search('cat'), 'https://g/x.gif');
  assert.deepEqual(state.giphy.calls, [['cat', { limit: 1 }]]);
});

test('giphy works without config and returns an empty string for no result', async () => {
  const { GiphyFetch, state } = createFakeGifs();
  const engine = createGiphyEngine({ giphy: new GiphyFetch('gg') });
  assert.equal(await engine.search('cat'), '');
  assert.deepEqual(state.giphy.calls, [['cat', { limit: 1 }]]);
});

test('giphy tolerates a result without images', async () => {
  const giphy = { search: async () => ({ data: [{}] }) };
  assert.equal(await createGiphyEngine({ giphy }).search('x'), '');
});
