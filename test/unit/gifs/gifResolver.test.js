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
      if (typeof answer === 'string') return [answer];
      return answer ?? [];
    },
  };
};

const createHarness = (engines, { rolls = [0.99] } = {}) => {
  const warnings = [];
  const timers = { scheduled: [], cleared: [] };
  const clock = {
    setTimeout: (fn, ms) => {
      timers.scheduled.push({ fn, ms });
      return timers.scheduled.length;
    },
    clearTimeout: (handle) => timers.cleared.push(handle),
  };
  let roll = 0;
  const random = () => rolls[Math.min(roll++, rolls.length - 1)];
  const logger = { warn: (...args) => warnings.push(args.join(' ')) };
  const resolver = createGifResolver({ engines, config, random, logger, clock });
  return { resolver, warnings, timers, rollCount: () => roll };
};

test('returns the text untouched and calls no engine when there is no token', async () => {
  const engine = createEngine('a');
  const { resolver } = createHarness([engine]);
  assert.deepEqual(await resolver.resolve('plain'), { content: 'plain', gifLinks: [] });
  assert.deepEqual(engine.queries, []);
});

test('uses the first engine with a result and skips the rest', async () => {
  const [a, b, c] = ['a', 'b', 'c'].map((n) => createEngine(n, { cat: `u${n}` }));
  const { resolver } = createHarness([a, b, c]);
  const result = await resolver.resolve('yo <gif! cat>');
  assert.deepEqual(result, { content: 'yo ', gifLinks: [{ match: '<gif! cat>', url: 'ua' }] });
  assert.deepEqual([b.queries, c.queries], [[], []]);
});

test('falls through empty engines in order', async () => {
  const a = createEngine('a');
  const b = createEngine('b', { cat: 'ub' });
  const c = createEngine('c', { cat: 'uc' });
  const { resolver, warnings } = createHarness([a, b, c]);
  const { gifLinks } = await resolver.resolve('<gif! cat>');
  assert.equal(gifLinks[0].url, 'ub');
  assert.deepEqual([a.queries, b.queries, c.queries], [['cat'], ['cat'], []]);
  assert.deepEqual(warnings, []);
});

test('leaves a placeholder and an empty url when every engine is empty', async () => {
  const { resolver } = createHarness([createEngine('a'), createEngine('b')]);
  assert.deepEqual(await resolver.resolve('yo <gif! funny cat>'), {
    content: 'yo <INSERT GIF:  funny cat>',
    gifLinks: [{ match: '<gif! funny cat>', url: '' }],
  });
});

test('searches with trimmed text cut to the configured length', async () => {
  const engine = createEngine('a');
  const { resolver } = createHarness([engine]);
  await resolver.resolve(`<gif!  ${'x'.repeat(49)} ${'y'.repeat(10)} >`);
  assert.deepEqual(engine.queries, [`${'x'.repeat(49)} `]);
});

test('falls through an engine that throws and logs one warning without a url', async () => {
  const bad = createEngine('bad', { cat: new Error('engine down') });
  const next = createEngine('next', { cat: 'u' });
  const { resolver, warnings } = createHarness([bad, next]);
  const { gifLinks } = await resolver.resolve('<gif! cat>');
  assert.equal(gifLinks[0].url, 'u');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bad.*cat.*engine down/);
});

test('never rejects when every engine throws', async () => {
  const engines = ['a', 'b'].map((n) => createEngine(n, { cat: new Error(`${n} down`) }));
  const { resolver, warnings } = createHarness(engines);
  const result = await resolver.resolve('x <gif! cat>');
  assert.deepEqual(result, { content: 'x <INSERT GIF:  cat>', gifLinks: [{ match: '<gif! cat>', url: '' }] });
  assert.equal(warnings.length, 2);
});

test('times out a hanging engine after timeoutMs and tries the next', async () => {
  const hanging = { name: 'slow', search: () => new Promise(() => {}) };
  const next = createEngine('next', { cat: 'u' });
  const { resolver, warnings, timers } = createHarness([hanging, next]);
  const pending = resolver.resolve('<gif! cat>');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.scheduled[0].ms, config.gifs.timeoutMs);
  timers.scheduled[0].fn();
  const { gifLinks } = await pending;
  assert.equal(gifLinks[0].url, 'u');
  assert.match(warnings[0], /slow timed out after 5000 ms/);
});

test('picks by the roll among several candidates', async () => {
  const urls = ['u0', 'u1', 'u2', 'u3', 'u4'];
  const first = createHarness([createEngine('a', { cat: urls })], { rolls: [0] });
  const last = createHarness([createEngine('a', { cat: urls })], { rolls: [0.99] });
  assert.equal((await first.resolver.resolve('<gif! cat>')).gifLinks[0].url, 'u0');
  assert.equal((await last.resolver.resolve('<gif! cat>')).gifLinks[0].url, 'u4');
});

test('a single candidate makes no roll', async () => {
  const h = createHarness([createEngine('a', { cat: 'only' })]);
  await h.resolver.resolve('<gif! cat>');
  assert.equal(h.rollCount(), 0);
});

test('consumes rolls in token order regardless of which lookup finishes first', async () => {
  const slow = {
    name: 'slow',
    search: async (query) => {
      if (query === 'one') await new Promise((resolve) => setImmediate(resolve));
      return [`${query}-a`, `${query}-b`];
    },
  };
  const { resolver } = createHarness([slow], { rolls: [0, 0.99] });
  const { gifLinks } = await resolver.resolve('<gif! one> and <gif! two>');
  assert.deepEqual(gifLinks.map((l) => l.url), ['one-a', 'two-b']);
});

test('resolves identical tokens independently', async () => {
  const engine = createEngine('a', { cat: ['u0', 'u1'] });
  const { resolver } = createHarness([engine], { rolls: [0, 0.99] });
  const { gifLinks } = await resolver.resolve('<gif! cat> <gif! cat>');
  assert.deepEqual(gifLinks.map((l) => l.url), ['u0', 'u1']);
  assert.equal(engine.queries.length, 2);
});

test('handles one resolved and one unresolved token', async () => {
  const { resolver } = createHarness([createEngine('a', { one: 'u1' })]);
  const result = await resolver.resolve('<gif! one> x <gif! two>');
  assert.deepEqual(result.gifLinks, [
    { match: '<gif! one>', url: 'u1' },
    { match: '<gif! two>', url: '' },
  ]);
  assert.equal(result.content, ' x <INSERT GIF:  two>');
});
