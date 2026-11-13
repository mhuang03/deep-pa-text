import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsUser, stripUserMention } from '../../../src/text/botMention.js';

const BOT = '900';

test('a written mention of the user is detected in both forms', () => {
  assert.equal(mentionsUser('<@900> hello', BOT), true);
  assert.equal(mentionsUser('hello <@!900>', BOT), true);
});

test('other users, roles and everyone are not a mention of the user', () => {
  assert.equal(mentionsUser('<@901> hello', BOT), false);
  assert.equal(mentionsUser('<@&900> hello', BOT), false);
  assert.equal(mentionsUser('@everyone hello', BOT), false);
  assert.equal(mentionsUser('9000 <@9001>', BOT), false);
});

test('empty content or an unknown user id never matches', () => {
  assert.equal(mentionsUser('', BOT), false);
  assert.equal(mentionsUser(null, BOT), false);
  assert.equal(mentionsUser('<@900>', undefined), false);
  assert.equal(mentionsUser('<@900>', ''), false);
  assert.equal(mentionsUser('<@abc>', '.*'), false);
  assert.equal(mentionsUser('<@bot-user> hi', 'bot-user'), true);
});

test('repeated calls give the same answer', () => {
  assert.equal(mentionsUser('<@900> a', BOT), true);
  assert.equal(mentionsUser('<@900> a', BOT), true);
});

test('stripping removes every mention of the user and tidies the spaces', () => {
  assert.equal(stripUserMention('<@900>  what do   we think <@!900>', BOT), 'what do we think');
  assert.equal(stripUserMention('hey <@901> and <@900>', BOT), 'hey <@901> and');
  assert.equal(stripUserMention('<@900>', BOT), '');
});

test('stripping without a user id or content returns the content unchanged', () => {
  assert.equal(stripUserMention('<@900> hi', undefined), '<@900> hi');
  assert.equal(stripUserMention(null, BOT), '');
});
