import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeneratorInputs } from '../../../src/llm/generatorInputs.js';
import { loadConfig } from '../../../src/config.js';

const config = loadConfig({});

const setup = ({ burstError = null, recentError = null, startersError = null, rows = [], burstEnabled = true } = {}) => {
  const warnings = [];
  const calls = { starters: [], recent: [] };
  const inputs = createGeneratorInputs({
    burstProfile: { rateFor: (persona) => { if (burstError) throw burstError; return persona === 'bob' ? 0.4 : 0.1; } },
    botMessageStore: { recent: (arg) => { calls.recent.push(arg); if (recentError) throw recentError; return [{ content: 'x' }, { content: 'y' }]; } },
    messageStore: { randomStarters: (arg) => { calls.starters.push(arg); if (startersError) throw startersError; return rows; } },
    config: { ...config, burst: { ...config.burst, enabled: burstEnabled } },
    logger: { warn: (m) => warnings.push(m) },
  });
  return { inputs, warnings, calls };
};

test('burstRate is the measured rate, zero when bursts are off, zero and warned on failure', () => {
  assert.equal(setup().inputs.burstRate('bob'), 0.4);
  assert.equal(setup({ burstEnabled: false }).inputs.burstRate('bob'), 0);
  const failing = setup({ burstError: new Error('sql') });
  assert.equal(failing.inputs.burstRate('bob'), 0);
  assert.match(failing.warnings[0], /Could not measure the burst rate: sql/);
});

test('recentBotMessages returns the stored texts, or nothing with a warning', () => {
  const ok = setup();
  assert.deepEqual(ok.inputs.recentBotMessages(), ['x', 'y']);
  assert.deepEqual(ok.calls.recent, [{ limit: config.retrieval.recentBotMessages }]);
  const failing = setup({ recentError: new Error('sql') });
  assert.deepEqual(failing.inputs.recentBotMessages(), []);
  assert.match(failing.warnings[0], /Could not load recent bot messages/);
});

test('starters over-fetch, drop spelling variants and cap at starterSamples', () => {
  const { inputs, calls } = setup({ rows: ['Hello there', 'hello  THERE', 'something else'] });
  assert.deepEqual(inputs.starters('alice'), ['Hello there', 'something else']);
  assert.deepEqual(calls.starters[0], {
    author: 'alice', minGapMs: config.revive.starterGapMs, limit: config.revive.starterSamples * config.retrieval.overFetchFactor,
  });
  const many = setup({ rows: Array.from({ length: 50 }, (_, i) => `starter number ${i}`) });
  assert.equal(many.inputs.starters('alice').length, config.revive.starterSamples);
});

test('a failed starters lookup yields none and a warning', () => {
  const { inputs, warnings } = setup({ startersError: new Error('sql') });
  assert.deepEqual(inputs.starters('alice'), []);
  assert.match(warnings[0], /Could not load conversation starters/);
});
