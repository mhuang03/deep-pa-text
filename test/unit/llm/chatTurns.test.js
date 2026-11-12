import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatMessages } from '../../../src/llm/chatTurns.js';

const turn = (speaker, content, isPersona = false) => ({ speaker, content, isPersona });

test('without turns the messages are system and user', () => {
  assert.deepEqual(buildChatMessages({ system: 's', user: 'u' }), [
    { role: 'system', content: 's' }, { role: 'user', content: 'u' },
  ]);
});

test('maps persona turns to assistant and others to prefixed user messages', () => {
  const messages = buildChatMessages({
    system: 's', user: 'u',
    turns: [turn('bob', 'hey', true), turn('alice', 'why')],
  });
  assert.deepEqual(messages, [
    { role: 'system', content: 's' }, { role: 'user', content: 'u' },
    { role: 'assistant', content: 'hey' }, { role: 'user', content: 'alice: why' },
  ]);
});

test('a leading user turn merges into the preamble', () => {
  const messages = buildChatMessages({ system: 's', user: 'u', turns: [turn('alice', 'root'), turn('bob', 'r', true), turn('alice', 'why')] });
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(messages[1].content, 'u\n\nalice: root');
});

test('consecutive users merge into one message with both prefixed lines', () => {
  const messages = buildChatMessages({ system: 's', user: 'u', turns: [turn('bob', 'a', true), turn('alice', 'x'), turn('dave', 'y')] });
  assert.equal(messages.at(-1).content, 'alice: x\n\ndave: y');
  assert.equal(messages.length, 4);
});

test('a thread rooted at the bot starts system, user, assistant and ends with user', () => {
  const messages = buildChatMessages({ system: 's', user: 'u', turns: [turn('bob', 'a', true), turn('alice', 'why')] });
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
});

test('does not mutate its inputs', () => {
  const turns = [turn('alice', 'x')];
  buildChatMessages({ system: 's', user: 'u', turns });
  assert.deepEqual(turns, [turn('alice', 'x')]);
});
