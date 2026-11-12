import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBackfillArgs } from '../../../src/backfill/args.js';

const DEFAULTS = { dryRun: false, skipHistory: false, syncVectors: false, before: null, limit: Infinity };

test('no arguments import the whole history', () => {
  assert.deepEqual(parseBackfillArgs([]), DEFAULTS);
});

test('parses each option', () => {
  assert.equal(parseBackfillArgs(['--dry-run']).dryRun, true);
  assert.equal(parseBackfillArgs(['--sync-vectors']).syncVectors, true);
  assert.equal(parseBackfillArgs(['--before', '123456']).before, '123456');
  assert.equal(parseBackfillArgs(['--limit', '120']).limit, 120);
  assert.deepEqual(parseBackfillArgs(['--skip-history', '--sync-vectors']), {
    ...DEFAULTS, skipHistory: true, syncVectors: true,
  });
});

const rejects = (argv, pattern) => {
  assert.throws(() => parseBackfillArgs(argv), (error) => {
    assert.equal(error.isUsageError, true);
    assert.match(error.message, pattern);
    return true;
  });
};

test('rejects an invalid limit', () => {
  rejects(['--limit', '0'], /--limit/);
  rejects(['--limit', '-3'], /--limit/);
  rejects(['--limit', '1.5'], /--limit/);
  rejects(['--limit', 'abc'], /--limit/);
});

test('rejects a before value that is not digits', () => {
  rejects(['--before', 'abc'], /--before/);
  rejects(['--before', '12x'], /--before/);
});

test('rejects --skip-history without --sync-vectors', () => {
  rejects(['--skip-history'], /--sync-vectors/);
});

test('rejects unknown options, positionals and missing values', () => {
  rejects(['--bogus'], /bogus/);
  rejects(['extra'], /extra/);
  rejects(['--limit'], /limit/);
});
