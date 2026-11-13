import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTopicSampler } from '../../../src/topics/topicSampler.js';
import { DEFAULTS } from '../../../src/config.js';
import { buildUserDirectory } from '../../../src/userData/loadData.js';
import { USERS } from '../../support/fixtures.js';

const NOW = 10_000_000;
const WINDOW = 1_000_000;
const config = { topics: { ...DEFAULTS.topics, recentWindowMs: WINDOW, maxMessages: 4, recentShare: 0.5 } };
const userDirectory = buildUserDirectory(USERS);

const row = (id, { author = 'alice', timestamp = NOW, content } = {}) => ({
  id, author, timestamp, content: content ?? `this is a long enough message with words ${id}`,
});

const sampler = (rows, overrides = {}) => {
  const calls = [];
  const messageStore = { topicSample: (options) => { calls.push(options); return rows; } };
  const topics = { ...config.topics, ...overrides };
  return { calls, ...createTopicSampler({ messageStore, userDirectory, config: { topics } }) };
};

test('asks the store for over-fetched recent and older limits since the window start', () => {
  const { sample, calls } = sampler([]);
  sample({ maxMessages: 10, now: NOW });
  assert.deepEqual(calls, [{ minChars: config.topics.minChars, sinceMs: NOW - WINDOW, recentLimit: 10, olderLimit: 10 }]);
});

test('rounds the recent share and gives the rest to older rows', () => {
  const { sample, calls } = sampler([], { recentShare: 0.6 });
  sample({ maxMessages: 5, now: NOW });
  assert.equal(calls[0].recentLimit, 3 * 2);
  assert.equal(calls[0].olderLimit, 2 * 2);
});

test('drops rows that are not eligible text, and rows of authors outside the directory', () => {
  const rows = [
    row('ok'), row('short', { content: 'yeah lol' }), row('gif', { content: '<gif! a long gif search query here>' }),
    row('stranger', { author: 'mallory' }), row('stretch', { content: 'yeahhhh yeahhh yeahhh yeahhh yeahhh yeah' }),
  ];
  const { sample } = sampler(rows);
  const result = sample({ maxMessages: 10, now: NOW });
  assert.equal(result.sampled, 5);
  assert.deepEqual(result.rows.map((r) => r.id), ['ok']);
});

test('drops a stock phrase that occurs more than maxPhraseRepeats times, keeps one at the limit', () => {
  const phrase = 'we should all go and get some food soon';
  const rows = [
    ...[1, 2, 3].map((n) => row(`p${n}`, { content: phrase })), row('q1', { content: 'Another repeated phrase here, friends!' }),
    row('q2', { content: 'another repeated phrase here friends' }),
  ];
  const { sample } = sampler(rows, { maxMessages: 10 });
  const result = sample({ maxMessages: 10, now: NOW });
  assert.deepEqual(result.rows.map((r) => r.id).sort(), ['q1', 'q2']);
});

test('cuts each group to its limit', () => {
  const recent = [1, 2, 3, 4].map((n) => row(`r${n}`, { timestamp: NOW - 10 }));
  const older = [1, 2, 3, 4].map((n) => row(`o${n}`, { timestamp: NOW - WINDOW - 10 }));
  const { sample } = sampler([...recent, ...older]);
  const result = sample({ maxMessages: 4, now: NOW });
  assert.equal(result.rows.filter((r) => r.id.startsWith('r')).length, 2);
  assert.equal(result.rows.filter((r) => r.id.startsWith('o')).length, 2);
});

test('a short group lets the other fill the remainder up to maxMessages', () => {
  const recent = [1].map((n) => row(`r${n}`, { timestamp: NOW - 10 }));
  const older = [1, 2, 3, 4, 5].map((n) => row(`o${n}`, { timestamp: NOW - WINDOW - 10 }));
  const { sample } = sampler([...recent, ...older]);
  const result = sample({ maxMessages: 4, now: NOW });
  assert.equal(result.rows.length, 4);
  assert.deepEqual(result.rows.map((r) => r.id), ['r1', 'o1', 'o2', 'o3']);
});

test('never returns more than maxMessages', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => row(`r${n}`, { timestamp: NOW - 10 }));
  const { sample } = sampler(rows);
  assert.equal(sample({ maxMessages: 4, now: NOW }).rows.length, 4);
});
