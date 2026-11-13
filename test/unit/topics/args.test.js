import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTopicsArgs, TOPICS_USAGE } from '../../../src/topics/args.js';

const usage = (argv, pattern) => assert.throws(
  () => parseTopicsArgs(argv), (error) => error.isUsageError === true && pattern.test(error.message), argv.join(' '),
);

test('no options builds the bank', () => {
  assert.deepEqual(parseTopicsArgs([]), { dryRun: false, maxMessages: null, list: false, hide: null });
});

test('parses each option', () => {
  assert.equal(parseTopicsArgs(['--dry-run']).dryRun, true);
  assert.equal(parseTopicsArgs(['--max-messages', '500']).maxMessages, 500);
  assert.equal(parseTopicsArgs(['--list']).list, true);
  assert.equal(parseTopicsArgs(['--hide', '12']).hide, 12);
  assert.deepEqual(parseTopicsArgs(['--dry-run', '--max-messages', '1']), { dryRun: true, maxMessages: 1, list: false, hide: null });
});

test('rejects unknown options and positional arguments', () => {
  usage(['--bogus'], /bogus/);
  usage(['extra'], /./);
});

test('rejects a max-messages or hide value that is not an integer of at least 1', () => {
  ['0', '-1', '1.5', 'abc', ''].forEach((value) => {
    usage(['--max-messages', value], /--max-messages/);
    usage(['--hide', value], /--hide/);
  });
});

test('--list and --hide cannot be combined with each other or with the build options', () => {
  usage(['--list', '--hide', '1'], /cannot be combined/);
  usage(['--list', '--dry-run'], /cannot be combined/);
  usage(['--hide', '1', '--max-messages', '5'], /cannot be combined/);
});

test('the usage text names every option', () => {
  ['--dry-run', '--max-messages', '--list', '--hide'].forEach((option) => assert.ok(TOPICS_USAGE.includes(option)));
});
