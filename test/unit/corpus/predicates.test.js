import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPROVED_AUTHORS, createPredicates } from '../../../src/corpus/predicates.js';
import { loadConfig } from '../../../src/config.js';

const predicates = createPredicates({ usernames: new Set(['alice']), config: loadConfig({}) });
const run = (name, message) => predicates.find((p) => p.name === name).test(message);
const msg = (content, author = 'alice') => ({ author, content });

test('predicates keep the legacy order and names', () => {
  assert.deepEqual(predicates.map((p) => p.name), [
    'approvedAuthors', 'hasContent', 'minLength', 'maxLength',
    'noCommands', 'noConnections', 'noWordles', 'noStrands',
  ]);
  assert.equal(APPROVED_AUTHORS, 'approvedAuthors');
});

test('approvedAuthors accepts only known usernames', () => {
  assert.equal(run('approvedAuthors', msg('x', 'alice')), true);
  assert.equal(run('approvedAuthors', msg('x', 'mallory')), false);
});

test('hasContent rejects empty content', () => {
  assert.equal(run('hasContent', msg('')), false);
  assert.equal(run('hasContent', msg(' ')), true);
});

test('minLength boundary is 5', () => {
  assert.equal(run('minLength', msg('abcd')), false);
  assert.equal(run('minLength', msg('abcde')), true);
});

test('maxLength boundary is 200', () => {
  assert.equal(run('maxLength', msg('a'.repeat(200))), true);
  assert.equal(run('maxLength', msg('a'.repeat(201))), false);
});

test('noCommands rejects each prefix only at the start', () => {
  ['!', '$', '#', '%', '&', '-', '+', 'p!'].forEach((prefix) => {
    assert.equal(run('noCommands', msg(`${prefix}thing`)), false, prefix);
    assert.equal(run('noCommands', msg(`a${prefix}thing`)), true, prefix);
  });
});

test('noConnections rejects Connections and Puzzle # anywhere', () => {
  assert.equal(run('noConnections', msg('my Connections')), false);
  assert.equal(run('noConnections', msg('Puzzle #5')), false);
  assert.equal(run('noConnections', msg('Puzzle 5')), true);
});

test('noWordles matches the share format only', () => {
  assert.equal(run('noWordles', msg('Wordle 1234 4/6')), false);
  assert.equal(run('noWordles', msg('Wordle 1234 X/6')), true);
  assert.equal(run('noWordles', msg('Wordle is fun')), true);
});

test('noStrands matches the share format only', () => {
  assert.equal(run('noStrands', msg('Strands #12')), false);
  assert.equal(run('noStrands', msg('Strands is fun')), true);
});

test('honours config values', () => {
  const custom = createPredicates({
    usernames: new Set(),
    config: { filter: { minLength: 2, maxLength: 3, commandPrefixes: ['~'] } },
  });
  const by = (name) => custom.find((p) => p.name === name);
  assert.equal(by('minLength').test(msg('ab')), true);
  assert.equal(by('maxLength').test(msg('abcd')), false);
  assert.equal(by('noCommands').test(msg('~x')), false);
  assert.equal(by('noCommands').test(msg('!x')), true);
});

test('repeated runs of the regex predicates are stable', () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(run('noWordles', msg('Wordle 1 1/6')), false);
    assert.equal(run('noStrands', msg('Strands #1')), false);
  }
});
