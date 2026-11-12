import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeOpenAI } from '../../support/fakes/llm.js';
import { createChatClient } from '../../../src/llm/chatClient.js';

const llmConfig = (extra = {}) => ({ llm: { model: 'm-1', thinking: true, stream: false, ...extra } });
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
