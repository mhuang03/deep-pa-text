import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertChain, assertCommand, assertBurst, assertProfiles, assertBackfill, assertLifecycle, assertCatchUp, assertVector,
} from '../../../src/config/validateFeatures.js';
import { DEFAULTS } from '../../../src/config.js';

test('the default sections pass their own validators', () => {
  const pairs = [
    [assertChain, DEFAULTS.chain], [assertCommand, DEFAULTS.command], [assertBurst, DEFAULTS.burst],
    [assertProfiles, DEFAULTS.profiles], [assertBackfill, DEFAULTS.backfill], [assertLifecycle, DEFAULTS.lifecycle],
    [assertCatchUp, DEFAULTS.catchUp], [assertVector, DEFAULTS.vector],
  ];
  pairs.forEach(([assert_, section]) => assert.equal(assert_(section), section));
});

test('assertBackfill bounds the page size at Discord\'s 100 and requires a comparison page size', () => {
  assert.throws(() => assertBackfill({ ...DEFAULTS.backfill, pageSize: 101 }), /backfill\.pageSize/);
  assert.throws(() => assertBackfill({ ...DEFAULTS.backfill, comparisonPageSize: 0 }), /backfill\.comparisonPageSize/);
});

test('assertChain needs a decay in [0, 1] and at least two context turns', () => {
  assert.throws(() => assertChain({ ...DEFAULTS.chain, decay: 1.1 }), /chain\.decay/);
  assert.throws(() => assertChain({ ...DEFAULTS.chain, maxContextTurns: 1 }), /chain\.maxContextTurns/);
});

test('assertProfiles bounds the search limit', () => {
  assert.throws(() => assertProfiles({ ...DEFAULTS.profiles, searchLimit: 1001 }), /profiles\.searchLimit/);
});

test('assertCatchUp, assertVector and assertLifecycle reject non-positive values', () => {
  assert.throws(() => assertCatchUp({ ...DEFAULTS.catchUp, maxMessages: 0 }), /catchUp\.maxMessages/);
  assert.throws(() => assertVector({ ...DEFAULTS.vector, repairIntervalMs: 0 }), /vector\.repairIntervalMs/);
  assert.throws(() => assertLifecycle({ ...DEFAULTS.lifecycle, pollMs: 0 }), /lifecycle\.pollMs/);
});
