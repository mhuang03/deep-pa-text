import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatReceived, formatNoReply, formatNotReplyable, formatReply, formatRevive,
  formatCommandRequest, formatChainDecision, joinLines,
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

test('formats chain decisions with persona, bot turns and reason', () => {
  assert.equal(
    formatChainDecision({ persona: 'bob', botTurns: 4, decision: { reply: false, reason: 'chain-roll' } }),
    '    [CHAIN: bob, 4 bot turns, chain-roll, no reply]',
  );
  assert.equal(
    formatChainDecision({ persona: 'bob', botTurns: 1, decision: { reply: true, reason: 'chain-guaranteed' } }),
    '    [CHAIN: bob, 1 bot turns, chain-guaranteed]',
  );
});
