import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as feature from '../../../src/config/featureSections.js';

test('buildLlm and buildGifs read their keys from the environment', () => {
  assert.equal(feature.buildLlm({ DEEPSEEK_API_KEY: 'k' }).apiKey, 'k');
  assert.equal(feature.buildLlm({}).apiKey, undefined);
  const gifs = feature.buildGifs({ KLIPY_API_KEY: 'a', GIPHY_API_KEY: 'b', HUMOR_API_KEY: 'c' });
  assert.deepEqual([gifs.klipyApiKey, gifs.giphyApiKey, gifs.humorApiKey], ['a', 'b', 'c']);
});

test('feature flags default on and can be switched off', () => {
  assert.equal(feature.buildChain({}).enabled, true);
  assert.equal(feature.buildChain({ CHAIN_REPLIES: 'false' }).enabled, false);
  assert.equal(feature.buildBurst({ BURSTS: 'false' }).enabled, false);
  assert.equal(feature.buildCatchUp({ CATCH_UP: 'false' }).enabled, false);
  assert.equal(feature.buildCatchUp({}).enabled, true);
});

test('buildBackfill holds the comparison page size next to the paging limits', () => {
  assert.deepEqual(feature.buildBackfill(), {
    pageSize: 100, batchSize: 100, pageRetries: 3, retryDelayMs: 2000, pageTimeoutMs: 30000, comparisonPageSize: 500,
  });
});

test('buildLogging, buildLifecycle and buildVector name their tunables', () => {
  assert.deepEqual(feature.buildLogging(), { locale: 'en-US', timeZone: 'America/Chicago' });
  assert.deepEqual(Object.keys(feature.buildLifecycle()).sort(), ['graceMs', 'pollMs']);
  assert.deepEqual(Object.keys(feature.buildVector()).sort(), ['repairIntervalMs', 'repairWindowMs']);
});

test('every other section builder returns a plain object', () => {
  [feature.buildContext, () => feature.buildMention({}), feature.buildTyping, feature.buildProfiles].forEach((build) => {
    const section = build();
    assert.equal(Object.getPrototypeOf(section), Object.prototype);
    assert.ok(Object.keys(section).length > 0);
  });
});
