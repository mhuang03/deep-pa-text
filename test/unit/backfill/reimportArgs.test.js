import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReimportArgs } from '../../../src/backfill/reimportArgs.js';

test('no arguments mean a dry run', () => {
  assert.deepEqual(parseReimportArgs([]), { yes: false, resume: false });
});

test('parses --yes and --resume', () => {
  assert.deepEqual(parseReimportArgs(['--yes']), { yes: true, resume: false });
  assert.deepEqual(parseReimportArgs(['--yes', '--resume']), { yes: true, resume: true });
  assert.deepEqual(parseReimportArgs(['--resume']), { yes: false, resume: true });
});

test('unknown options and positionals are usage errors', () => {
  ['--bogus', 'extra'].forEach((arg) => {
    assert.throws(() => parseReimportArgs([arg]), (error) => error.isUsageError === true);
  });
});
