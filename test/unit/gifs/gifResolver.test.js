import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGifResolver } from '../../../src/gifs/gifResolver.js';
import { loadConfig } from '../../../src/config.js';

const config = loadConfig({});

const createEngine = (name, answers = {}) => {
  const queries = [];
  return {
    name,
    queries,
    search: async (query) => {
      queries.push(query);
      const answer = answers[query];
      if (answer instanceof Error) throw answer;
      return answer ?? '';
    },
  };
};

test('returns the text untouched and calls no engine when there is no token', async () => {
  const engine = createEngine('a');
  const result = await createGifResolver({ engines: [engine], config }).resolve('plain');
  assert.deepEqual(result, { content: 'plain', gifLinks: [] });
  assert.deepEqual(engine.queries, []);
});

test('uses the first engine with a result and skips the rest', async () => {
  const [a, b, c] = ['a', 'b', 'c'].map((n) => createEngine(n, n === 'a' ? { cat: 'ua' } : { cat: `u${n}` }));
  const result = await createGifResolver({ engines: [a, b, c], config }).resolve('yo <gif! cat>');
  assert.deepEqual(result, { content: 'yo ', gifLinks: [{ match: '<gif! cat>', url: 'ua' }] });
  assert.deepEqual([b.queries, c.queries], [[], []]);
});

test('falls through empty engines in order', async () => {
  const a = createEngine('a');
  const b = createEngine('b', { cat: 'ub' });
  const c = createEngine('c', { cat: 'uc' });
  const { gifLinks } = await createGifResolver({ engines: [a, b, c], config }).resolve('<gif! cat>');
  assert.equal(gifLinks[0].url, 'ub');
  assert.deepEqual([a.queries, b.queries, c.queries], [['cat'], ['cat'], []]);
});

test('leaves a placeholder and an empty url when every engine is empty', async () => {
  const engines = [createEngine('a'), createEngine('b')];
  const result = await createGifResolver({ engines, config }).resolve('yo <gif! funny cat>');
  assert.deepEqual(result, {
    content: 'yo <INSERT GIF:  funny cat>',
    gifLinks: [{ match: '<gif! funny cat>', url: '' }],
  });
});

test('returns gifLinks in token order even when later tokens finish first', async () => {
  const slow = {
    name: 'slow',
    search: async (query) => {
      if (query === 'one') await new Promise((resolve) => setImmediate(resolve));
      return `u-${query}`;
    },
  };
  const result = await createGifResolver({ engines: [slow], config }).resolve('<gif! one> and <gif! two>');
  assert.deepEqual(result.gifLinks.map((l) => l.url), ['u-one', 'u-two']);
  assert.equal(result.content, ' and ');
});

test('handles one resolved and one unresolved token', async () => {
  const engine = createEngine('a', { one: 'u1' });
  const result = await createGifResolver({ engines: [engine], config }).resolve('<gif! one> x <gif! two>');
  assert.deepEqual(result.gifLinks, [
    { match: '<gif! one>', url: 'u1' },
    { match: '<gif! two>', url: '' },
  ]);
  assert.equal(result.content, ' x <INSERT GIF:  two>');
});

test('searches with trimmed text cut to the configured length', async () => {
  const engine = createEngine('a');
  const term = `${'x'.repeat(49)} ${'y'.repeat(10)}`;
  await createGifResolver({ engines: [engine], config }).resolve(`<gif!  ${term} >`);
  assert.deepEqual(engine.queries, [`${'x'.repeat(49)} `]);
});

test('rejects when an engine throws', async () => {
  const bad = createEngine('bad', { cat: new Error('engine down') });
  const next = createEngine('next', { cat: 'u' });
  await assert.rejects(
    createGifResolver({ engines: [bad, next], config }).resolve('<gif! cat>'),
    { message: 'engine down' },
  );
  assert.deepEqual(next.queries, []);
});
