import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertGifs, assertStorage, assertPersona, assertFilter, assertDiscord, checkRules } from '../../../src/config/validate.js';
import { DEFAULTS } from '../../../src/config.js';

test('the default sections pass their own validators', () => {
  assert.equal(assertGifs(DEFAULTS.gifs), DEFAULTS.gifs);
  assert.equal(assertStorage(DEFAULTS.storage), DEFAULTS.storage);
  assert.equal(assertPersona(DEFAULTS.persona), DEFAULTS.persona);
});

test('assertStorage rejects a chunk size below one', () => {
  assert.throws(() => assertStorage({ ...DEFAULTS.storage, chunkSize: 0 }), /storage\.chunkSize must be an integer of at least 1/);
});

test('assertPersona keeps the missing similarity in (0, 1]', () => {
  assert.throws(() => assertPersona({ ...DEFAULTS.persona, missingSimilarity: 0 }), /persona\.missingSimilarity/);
  assert.equal(assertPersona({ ...DEFAULTS.persona, missingSimilarity: 1 }).missingSimilarity, 1);
});

test('assertFilter refuses a minimum above the maximum', () => {
  assert.throws(() => assertFilter({ ...DEFAULTS.filter, minLength: 10, maxLength: 5 }), /minLength must not be greater/);
});

test('assertDiscord needs at least one embed and a non-negative preview', () => {
  assert.throws(() => assertDiscord({ ...DEFAULTS.discord, maxEmbeds: 0 }), /maxEmbeds/);
  assert.throws(() => assertDiscord({ ...DEFAULTS.discord, modalPreviewChars: -1 }), /modalPreviewChars/);
});

test('checkRules is re-exported for the other validators', () => {
  assert.equal(typeof checkRules, 'function');
});
