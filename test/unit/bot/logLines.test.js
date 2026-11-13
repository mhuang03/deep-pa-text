import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatReceived, formatNoReply, formatNotReplyable, formatReply, formatRevive,
  formatCommandRequest, formatChain, formatMentionWithoutTarget, formatFailure, formatConversation, joinLines,
} from '../../../src/bot/logLines.js';

const logging = { locale: 'en-US', timeZone: 'America/Chicago' };
const record = { id: '1', author: 'alice', content: 'hello there', timestamp: Date.parse('2026-11-12T18:00:00Z'), reference: null };
const legacyStamp = new Date(record.timestamp).toLocaleString('en-US', { timeZone: 'America/Chicago' });

test('formats the received line like the legacy report', () => {
  assert.equal(
    formatReceived({ record, kept: true, logging }),
    `[${legacyStamp}] alice: hello there\n  [filter kept: yes] (reference: null)`,
  );
  assert.match(formatReceived({ record: { ...record, reference: '9' }, kept: false, logging }), /kept: no\] \(reference: 9\)$/);
});

test('formats no-reply reasons', () => {
  assert.equal(formatNotReplyable(), '    [NOREPLY: not replyable]');
  assert.equal(formatNoReply({ reason: 'rate-limited' }), '    [NOREPLY: rate limited]');
  assert.equal(formatNoReply({ reason: 'in-flight' }), '    [NOREPLY: another reply is in flight]');
  assert.equal(formatNoReply({ reason: 'cooldown' }), '    [NOREPLY: cooling down after a failed reply]');
  assert.equal(formatNoReply({ reason: 'random', roll: 0.456, chance: 0.1 }), '    [NOREPLY: random 0.46 > 0.1]');
});

test('formats reply, revive and command lines', () => {
  assert.equal(formatReply({ persona: 'bob', response: 'yo' }), '    [REPLY] bob: yo');
  assert.equal(formatRevive({ persona: 'bob', response: 'yo' }), '[REVIVE] bob: yo');
  assert.equal(
    formatCommandRequest({ requester: 'carol', record, logging }),
    `[REQUEST REPLY from carol] [${legacyStamp}] alice: hello there`,
  );
});

test('joins lines with newlines', () => {
  assert.equal(joinLines(['a', 'b']), 'a\nb');
});

test('formats the chain line with persona and bot turns, and the mention line with nothing to answer', () => {
  assert.equal(formatChain({ persona: 'bob', botTurns: 4 }), '    [CHAIN: bob, 4 bot turns]');
  assert.equal(formatMentionWithoutTarget(), '    [MENTION: nothing to reply to]');
  assert.equal(formatFailure({ what: 'Error processing message', messageId: '9', trigger: 'mention', persona: 'bob' }),
    'Error processing message 9 (mention reply as bob):');
});

test('formatFailure names the work, message, trigger, persona and stage', () => {
  assert.equal(
    formatFailure({ what: 'Error processing message', messageId: '123', trigger: 'auto', persona: 'bob', stage: 'delivery' }),
    'Error processing message 123 (auto reply as bob, stage delivery):',
  );
});

test('formatFailure leaves out what is unknown', () => {
  assert.equal(formatFailure({ what: 'Error in revive interval' }), 'Error in revive interval:');
  assert.equal(formatFailure({ what: 'Error', trigger: 'revive', persona: 'bob' }), 'Error (revive as bob):');
  assert.equal(formatFailure({ what: 'Error', messageId: '9', stage: 'generation' }), 'Error 9 (stage generation):');
  assert.equal(formatFailure({ what: 'Error', persona: 'bob' }), 'Error (as bob):');
  assert.equal(formatFailure({ what: 'Error', trigger: 'chain' }), 'Error (chain reply):');
});

test('formatConversation summarises topic, people and delivered turns', () => {
  assert.equal(
    formatConversation({ topic: 'Weekend plans', personas: ['alice', 'bob'], delivered: 2, planned: 4 }),
    '[CONVERSATION] Weekend plans (alice, bob): 2 of 4 turns delivered',
  );
});

test('formatFailure labels a conversation turn', () => {
  assert.equal(
    formatFailure({ what: 'Conversation c1 ended', trigger: 'conversation', persona: 'bob', stage: 'generation' }),
    'Conversation c1 ended (conversation turn as bob, stage generation):',
  );
});
