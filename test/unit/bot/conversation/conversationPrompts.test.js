import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATION_TOPIC_SYSTEM_PROMPT, buildTopicPrompt } from '../../../../src/bot/conversation/conversationPrompts.js';

const NOW = Date.parse('2026-11-12T18:00:00Z');
const TZ = 'America/Chicago';

const CANDIDATES = [
  { label: 'Camping trips', summary: 'People plan trips.', samples: [{ author: 'alice', text: 'pack the tent' }] },
  { label: null, summary: null, samples: [{ author: 'bob', text: 'what a game' }] },
];

const input = (overrides = {}) => ({
  now: NOW, context: {}, recent: [], candidates: CANDIDATES, openers: [], timeZone: TZ, ...overrides,
});

test('the system prompt asks for one JSON object with choice, topic and premise', () => {
  assert.match(CONVERSATION_TOPIC_SYSTEM_PROMPT, /^You are planning a short group chat between members of a private Discord server\./);
  assert.match(CONVERSATION_TOPIC_SYSTEM_PROMPT, /\{"choice": <number of the candidate you chose>, "topic": "<at most 8 words>", "premise": "<one or two sentences: what prompts the conversation and the angle it takes>"\}/);
  assert.match(CONVERSATION_TOPIC_SYSTEM_PROMPT, /stay within what its sample messages show these people actually talk about\.$/);
});

test('with only the time and the candidates, the other sections are omitted', () => {
  assert.equal(buildTopicPrompt(input()), [
    'It is Thursday 12:00 PM.',
    [
      'Candidate topics:',
      '1. Camping trips: People plan trips.',
      'Sample messages: [{"author":"alice","text":"pack the tent"}]',
      '2. (unnamed)',
      'Sample messages: [{"author":"bob","text":"what a game"}]',
    ].join('\n'),
  ].join('\n\n'));
});

test('every section present, in order, with the quiet time, transcript, recent topics and openers', () => {
  const context = {
    quietMs: 5 * 3600000,
    transcript: [{ speaker: 'carol', content: 'see you all later', timestamp: NOW - 5 * 3600000, replyTo: null }],
  };
  const prompt = buildTopicPrompt(input({
    context, recent: ['Old topic', 'Another'], openers: [{ author: 'dave', text: 'anyone up for a game' }],
  }));
  assert.equal(prompt, [
    'It is Thursday 12:00 PM. The channel has been quiet for about 5 hours.',
    'Here is the end of the last conversation in the channel, oldest first:\n[07:00] carol: see you all later',
    'These topics were used recently. Do not choose them again:\n["Old topic","Another"]',
    [
      'Candidate topics:',
      '1. Camping trips: People plan trips.',
      'Sample messages: [{"author":"alice","text":"pack the tent"}]',
      '2. (unnamed)',
      'Sample messages: [{"author":"bob","text":"what a game"}]',
    ].join('\n'),
    'Messages that have restarted this chat after a quiet spell:\n[{"author":"dave","text":"anyone up for a game"}]',
  ].join('\n\n'));
});

test('an empty transcript, no recent topics and no openers leave their sections out', () => {
  const prompt = buildTopicPrompt(input({ context: { transcript: [], quietMs: null } }));
  assert.ok(!prompt.includes('last conversation'));
  assert.ok(!prompt.includes('used recently'));
  assert.ok(!prompt.includes('restarted'));
  assert.ok(!prompt.includes('quiet'));
});

test('candidates are numbered from 1', () => {
  const prompt = buildTopicPrompt(input());
  assert.match(prompt, /\n1\. Camping trips/);
  assert.match(prompt, /\n2\. \(unnamed\)/);
});
