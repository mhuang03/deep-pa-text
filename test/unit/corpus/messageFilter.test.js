import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageFilter } from '../../../src/corpus/messageFilter.js';
import { loadConfig } from '../../../src/config.js';
import { PING_CACHE, USERS } from '../../support/fixtures.js';
import { FILTER_TABLE } from './filterTable.js';

const createSubject = () =>
  createMessageFilter({ users: USERS, pingCache: PING_CACHE, config: loadConfig({}) });

const record = (content, author = 'alice') => ({
  id: 'm1', author, content, timestamp: 1700000000000, reference: 'm0',
});

FILTER_TABLE.forEach(([input, expected]) => {
  const label = JSON.stringify(input)?.slice(0, 40);

  test(`filter maps ${label} to ${JSON.stringify(expected)?.slice(0, 40)}`, () => {
    const result = createSubject().filter(record(input));
    assert.equal(result?.content ?? null, expected);
  });

  test(`filterAnyAuthor agrees with filter for ${label}`, () => {
    const subject = createSubject();
    assert.deepEqual(subject.filterAnyAuthor(record(input)), subject.filter(record(input)));
  });

  test(`transform is idempotent for ${label}`, () => {
    const subject = createSubject();
    const once = subject.transform(input);
    assert.equal(subject.transform(once), once);
  });
});

test('keeps id, author, timestamp and reference of a kept message', () => {
  const result = createSubject().filter(record('<@111> hello there'));
  assert.deepEqual(result, {
    id: 'm1', author: 'alice', content: '@alice hello there', timestamp: 1700000000000, reference: 'm0',
  });
});

test('filter drops a non-approved author that filterAnyAuthor keeps', () => {
  const subject = createSubject();
  assert.equal(subject.filter(record('hello there', 'mallory')), null);
  assert.equal(subject.filterAnyAuthor(record('hello there', 'mallory')).content, 'hello there');
});

test('filterAnyAuthor still applies every content predicate', () => {
  assert.equal(createSubject().filterAnyAuthor(record('hi', 'mallory')), null);
});

test('does not mutate its input', () => {
  const subject = createSubject();
  const input = record('<@111> hello there');
  const snapshot = structuredClone(input);
  const result = subject.filter(input);
  subject.filterAnyAuthor(input);
  assert.deepEqual(input, snapshot);
  assert.notEqual(result, input);
});

test('treats falsy content as an empty string', () => {
  const subject = createSubject();
  [undefined, null, ''].forEach((content) => {
    assert.equal(subject.transform(content), '');
    assert.equal(subject.filter(record(content)), null);
  });
});

test('repeated calls give identical results (no regex state leak)', () => {
  const subject = createSubject();
  const inputs = ['Wordle 1234 4/6 nice', 'Strands #123 easy', 'hello there friend'];
  inputs.forEach((content) => {
    const first = subject.filter(record(content));
    for (let i = 0; i < 4; i++) assert.deepEqual(subject.filter(record(content)), first);
  });
});

test('filterAnyAuthor excludes approvedAuthors by name, not position', () => {
  const subject = createSubject();
  // A real approved author is irrelevant: only the predicate name matters, so
  // an unapproved author passes while every other predicate still runs.
  assert.notEqual(subject.filterAnyAuthor(record('hello there', 'nobody')), null);
  assert.equal(subject.filterAnyAuthor(record('!hello there', 'nobody')), null);
});
