import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeOpenAI } from '../../support/fakes/llm.js';
import { createChatClient } from '../../../src/llm/chatClient.js';

const llmConfig = (extra = {}) => ({ llm: { model: 'm-1', thinking: true, stream: false, emptyRetries: 1, ...extra } });
const setup = (extra) => {
  const fake = createFakeOpenAI();
  const client = new fake.OpenAI({ apiKey: 'k' });
  return { fake, chat: createChatClient({ client, config: llmConfig(extra) }) };
};

test('sends the request shape with thinking enabled', async () => {
  const { fake, chat } = setup();
  await chat.complete({ system: 'sys', user: 'usr' });
  assert.deepEqual(fake.state.calls, [{
    model: 'm-1',
    thinking: { type: 'enabled' },
    stream: false,
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }],
  }]);
});

test('omits thinking when disabled', async () => {
  const { fake, chat } = setup({ thinking: false });
  await chat.complete({ system: 's', user: 'u' });
  assert.equal('thinking' in fake.state.calls[0], false);
});

test('returns the content unmodified', async () => {
  const { fake, chat } = setup();
  fake.state.respondWith('  keep  <gif! x>\n');
  assert.equal(await chat.complete({ system: 's', user: 'u' }), '  keep  <gif! x>\n');
});

test('propagates client errors', async () => {
  const { fake, chat } = setup();
  fake.state.respondWith(new Error('llm down'));
  await assert.rejects(chat.complete({ system: 's', user: 'u' }), /llm down/);
});

const EMPTY_VARIANTS = [
  ['null content', null],
  ['an empty string', ''],
  ['whitespace only', '  \n '],
  ['no choices', { choices: [] }],
  ['non-string content', { choices: [{ message: { content: 42 } }] }],
];

for (const [label, empty] of EMPTY_VARIANTS) {
  test(`retries once when the completion has ${label}`, async () => {
    const { fake, chat } = setup({ emptyRetries: 1 });
    fake.state.respondWith([empty, 'second try']);
    assert.equal(await chat.complete({ system: 's', user: 'u' }), 'second try');
    assert.equal(fake.state.calls.length, 2);
    assert.deepEqual(fake.state.calls[0], fake.state.calls[1]);
  });
}

test('throws after emptyRetries additional empty completions', async () => {
  const { fake, chat } = setup({ emptyRetries: 1 });
  fake.state.respondWith(['', null]);
  await assert.rejects(chat.complete({ system: 's', user: 'u' }), /LLM returned an empty response/);
  assert.equal(fake.state.calls.length, 2);
});

test('emptyRetries 0 throws after a single call', async () => {
  const { fake, chat } = setup({ emptyRetries: 0 });
  fake.state.respondWith('');
  await assert.rejects(chat.complete({ system: 's', user: 'u' }), /LLM returned an empty response/);
  assert.equal(fake.state.calls.length, 1);
});

test('an SDK error is not retried', async () => {
  const { fake, chat } = setup({ emptyRetries: 3 });
  fake.state.respondWith(new Error('llm down'));
  await assert.rejects(chat.complete({ system: 's', user: 'u' }), /llm down/);
  assert.equal(fake.state.calls.length, 1);
});
