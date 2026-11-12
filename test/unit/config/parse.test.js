import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readVariable, parseBoolean, parsePort, parseId, parsePersonaDisplay,
} from '../../../src/config/parse.js';
import { isConfigError } from '../../../src/config/errors.js';

test('readVariable trims and treats unset, empty and blank as undefined', () => {
  assert.equal(readVariable({ A: '  x  ' }, 'A'), 'x');
  assert.equal(readVariable({ A: '' }, 'A'), undefined);
  assert.equal(readVariable({ A: '   ' }, 'A'), undefined);
  assert.equal(readVariable({}, 'A'), undefined);
  assert.equal(readVariable({ A: 5 }, 'A'), undefined);
});

test('parseBoolean accepts true and false in any case and falls back when unset', () => {
  assert.equal(parseBoolean({ B: 'TRUE' }, 'B', false), true);
  assert.equal(parseBoolean({ B: 'false' }, 'B', true), false);
  assert.equal(parseBoolean({}, 'B', true), true);
  assert.throws(() => parseBoolean({ B: 'yes' }, 'B', true), (error) => isConfigError(error) && /B must be "true" or "false"/.test(error.message));
});

test('parsePort accepts 1 to 65535 and rejects the rest', () => {
  assert.equal(parsePort({ CHROMA_PORT: '1' }, 7), 1);
  assert.equal(parsePort({ CHROMA_PORT: '65535' }, 7), 65535);
  assert.equal(parsePort({}, 7), 7);
  ['0', '65536', '-1', '8e3', '1.5', 'abc'].forEach((value) => {
    assert.throws(() => parsePort({ CHROMA_PORT: value }, 7), /CHROMA_PORT must be an integer/);
  });
});

test('parseId accepts 5 to 25 digits', () => {
  assert.equal(parseId({ ID: '12345' }, 'ID', 'x'), '12345');
  assert.equal(parseId({}, 'ID', 'fallback'), 'fallback');
  ['1234', '1'.repeat(26), '12a45', '-12345'].forEach((value) => {
    assert.throws(() => parseId({ ID: value }, 'ID', 'x'), /ID must be a Discord id/);
  });
});

test('parsePersonaDisplay accepts embed and webhook only', () => {
  assert.equal(parsePersonaDisplay({ PERSONA_DISPLAY: 'webhook' }, 'embed'), 'webhook');
  assert.equal(parsePersonaDisplay({}, 'embed'), 'embed');
  assert.throws(() => parsePersonaDisplay({ PERSONA_DISPLAY: 'plain' }, 'embed'), /one of embed, webhook/);
});
