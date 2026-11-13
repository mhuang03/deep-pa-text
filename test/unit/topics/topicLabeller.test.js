import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTopicLabeller } from '../../../src/topics/topicLabeller.js';
import { TOPIC_LABEL_SYSTEM_PROMPT } from '../../../src/topics/topicPrompts.js';
import { DEFAULTS } from '../../../src/config.js';

const REPS = [{ id: '1', author: 'alice', content: 'hello there' }, { id: '2', author: 'bob', content: 'general kenobi' }];

const setup = (answer, topics = DEFAULTS.topics) => {
  const requests = [];
  const warnings = [];
  const chatClient = {
    complete: async (request) => {
      requests.push(request);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const logger = { warn: (...args) => warnings.push(args) };
  return { requests, warnings, labeller: createTopicLabeller({ chatClient, logger, config: { topics } }) };
};

test('sends the system prompt and the representatives as JSON author and text', async () => {
  const { labeller, requests } = setup('{"usable": false}');
  await labeller.label(REPS);
  assert.equal(requests[0].system, TOPIC_LABEL_SYSTEM_PROMPT);
  assert.deepEqual(JSON.parse(requests[0].user), [
    { author: 'alice', text: 'hello there' }, { author: 'bob', text: 'general kenobi' },
  ]);
});

test('the prompt tells the model about private matters and harassment', () => {
  assert.match(TOPIC_LABEL_SYSTEM_PROMPT, /one person's private matters \(health, relationships, money, a conflict\), or are insults or harassment/);
  assert.match(TOPIC_LABEL_SYSTEM_PROMPT, /at most 8 words/);
});

test('an usable answer is accepted with trimmed, whitespace-collapsed text cut to the limits', async () => {
  const topics = { ...DEFAULTS.topics, maxLabelChars: 10, maxSummaryChars: 12 };
  const answer = 'Sure:\n{"usable": true, "topic": "  Camping \\n  trips   and more ", "summary": "They  plan\\nthings carefully."}';
  const { labeller } = setup(answer, topics);
  assert.deepEqual(await labeller.label(REPS), { status: 'accepted', topic: 'Camping tr', summary: 'They plan th' });
});

test('usable: false is rejected without warnings, even when topic and summary are empty', async () => {
  const { labeller, warnings } = setup('{"usable": false, "topic": "", "summary": ""}');
  assert.deepEqual(await labeller.label(REPS), { status: 'rejected' });
  assert.deepEqual(warnings, []);
});

test('invalid answers are failures that are logged', async () => {
  const bad = ['not json', '{"usable": "yes"}', '{"topic": "x", "summary": "y"}', '{"usable": true, "topic": "", "summary": "y"}',
    '{"usable": true, "topic": "x", "summary": "  "}', '{"usable": true, "topic": 5, "summary": "y"}'];
  for (const answer of bad) {
    const { labeller, warnings } = setup(answer);
    assert.deepEqual(await labeller.label(REPS), { status: 'failed' }, answer);
    assert.equal(warnings.length, 1, answer);
  }
});

test('a failing chat client is a logged failure, not an exception', async () => {
  const { labeller, warnings } = setup(new Error('timeout'));
  assert.deepEqual(await labeller.label(REPS), { status: 'failed' });
  assert.equal(warnings.length, 1);
});
