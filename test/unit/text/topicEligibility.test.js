import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  topicText, normalisedTopicText, topicWords, topicPrefix, isTopicEligible,
} from '../../../src/text/topicEligibility.js';

const LIMITS = { minWords: 5, minDistinctWords: 4, minChars: 25 };

test('topicText drops GIF tokens, emoji names, mentions and punctuation and collapses whitespace', () => {
  const cases = [
    ['<gif! happy cat>', ''],
    [':joy: :kekw:', ''],
    ['@alice @bob.smith', ''],
    ['  Hello,   world!!  ', 'Hello world'],
    ['it\'s fine <gif! shrug> really :ok: @carol', 'it\'s fine really'],
    ['a\n\tb', 'a b'],
    ['', ''],
    ['100% sure (maybe)', '100 sure maybe'],
  ];
  cases.forEach(([input, expected]) => assert.equal(topicText(input), expected, input));
});

test('normalisedTopicText lower-cases and collapses stretched letters', () => {
  assert.equal(normalisedTopicText('SOOOO Good'), 'so good');
  assert.equal(normalisedTopicText('mississippi'), 'mississippi');
});

test('topicWords and topicPrefix work on the normalised text', () => {
  assert.deepEqual(topicWords('<gif! x>'), []);
  assert.deepEqual(topicWords('One Two three'), ['one', 'two', 'three']);
  assert.equal(topicPrefix('One two three four five'), 'one two three');
  assert.equal(topicPrefix('only two'), 'only two');
});

test('isTopicEligible rejects filler and accepts real sentences', () => {
  const rejected = [
    'yes', 'yeah lol', 'ok sounds good', '<gif! cat dancing>', ':joy: :joy: :joy:', '@alice @bob @carol @dave @erin',
    'yeah yeah yeah yeah yeah', 'hahahahahaha lol ok', 'the the the the the the the',
  ];
  rejected.forEach((text) => assert.equal(isTopicEligible(text, LIMITS), false, text));
  assert.equal(isTopicEligible('we should plan the camping trip soon', LIMITS), true);
});

test('isTopicEligible is exact at each boundary', () => {
  assert.equal(isTopicEligible('abcd efgh ijkl mnop', LIMITS), false, 'four words');
  assert.equal(isTopicEligible('apple berry cherry dates elder', LIMITS), true, 'five words, 29 chars');
  assert.equal(isTopicEligible('abcd efgh ijkl mnop qrst', LIMITS), false, 'five words, 24 chars');
  assert.equal(isTopicEligible('abcd efgh ijkl mnop qrstu', LIMITS), true, 'five words, 25 chars');
});

test('the character boundary is measured on the normalised text', () => {
  const limits = { minWords: 1, minDistinctWords: 1, minChars: 5 };
  assert.equal(isTopicEligible('abcde', limits), true);
  assert.equal(isTopicEligible('abcd', limits), false);
  assert.equal(isTopicEligible('aaaaaaaaa', limits), false, 'collapses to one letter');
});

test('the distinct-word boundary counts repeats once', () => {
  const limits = { minWords: 5, minDistinctWords: 4, minChars: 1 };
  assert.equal(isTopicEligible('one two three four four', limits), true);
  assert.equal(isTopicEligible('one two three three three', limits), false);
});

test('text without spaces counts as one word and is never eligible', () => {
  assert.equal(isTopicEligible('今日は天気がとても良いので散歩に行きましょう', LIMITS), false);
});
