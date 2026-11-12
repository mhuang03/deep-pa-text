import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBurstProfile } from '../../../src/retrieval/burstProfile.js';
import { loadConfig } from '../../../src/config.js';

const config = loadConfig({});

const setup = (stats) => {
  const calls = [];
  let clock = 1000;
  const messageStore = { burstStats: (args) => (calls.push(args), stats) };
  const profile = createBurstProfile({ messageStore, config, now: () => clock });
  return { profile, calls, advance: (ms) => { clock += ms; } };
};

test('returns the measured rate once there are enough samples', () => {
  const { profile, calls } = setup({ samples: config.burst.minSamples, rate: 0.4 });
  assert.equal(profile.rateFor('bob'), 0.4);
  assert.deepEqual(calls, [{ author: 'bob', windowMs: config.burst.windowMs }]);
});

test('returns 0 below the minimum number of samples', () => {
  const { profile } = setup({ samples: config.burst.minSamples - 1, rate: 0.9 });
  assert.equal(profile.rateFor('bob'), 0);
});

test('caches per author until the cache expires', () => {
  const { profile, calls, advance } = setup({ samples: 50, rate: 0.5 });
  profile.rateFor('bob');
  profile.rateFor('bob');
  profile.rateFor('carol');
  assert.equal(calls.length, 2);
  advance(config.burst.cacheMs - 1);
  profile.rateFor('bob');
  assert.equal(calls.length, 2);
  advance(1);
  profile.rateFor('bob');
  assert.equal(calls.length, 3);
});
