import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHistoryMessage } from '../../../src/discord/historyMessage.js';
import { toMessageRecord } from '../../../src/discord/messageRecord.js';
import { readPersonaFromEmbeds } from '../../../src/discord/botPersona.js';
import { createFakeDiscord } from '../../support/fakes/discord.js';

test('copies the fields the importer needs into a plain object', () => {
  const fake = createFakeDiscord();
  const parent = fake.makeMessage({ id: 'p' });
  const message = fake.makeMessage({
    id: 'm', author: 'alice', content: 'hello', timestamp: 7, reference: parent.id,
    embeds: [{ author: { name: 'bob' } }, { image: { url: 'u' } }],
  });
  message.editedTimestamp = 9;
  assert.deepEqual(toHistoryMessage(message), {
    id: 'm',
    content: 'hello',
    createdTimestamp: 7,
    editedTimestamp: 9,
    author: { id: 'user-alice', username: 'alice', bot: false },
    webhookId: null,
    reference: { messageId: 'p' },
    embeds: [{ author: { name: 'bob' } }, { author: null }],
    url: message.url,
  });
});

test('defaults missing fields and reads builder-style embed authors', () => {
  const history = toHistoryMessage({
    id: 'm', createdTimestamp: 1, author: { id: 'a', username: 'u', bot: true }, webhookId: 'w',
    embeds: [{ data: { author: { name: 'carol' } } }], reference: { messageId: '' },
  });
  assert.equal(history.content, '');
  assert.equal(history.editedTimestamp, null);
  assert.equal(history.webhookId, 'w');
  assert.equal(history.reference, null);
  assert.deepEqual(history.embeds, [{ author: { name: 'carol' } }]);
});

test('is accepted unchanged by toMessageRecord and readPersonaFromEmbeds', () => {
  const history = toHistoryMessage({
    id: 'm', content: 'hi there', createdTimestamp: 5, author: { id: 'a', username: 'alice', bot: false },
    reference: { messageId: 'p' }, embeds: [{ author: { name: 'bob' } }],
  });
  assert.deepEqual(toMessageRecord(history), {
    id: 'm', author: 'alice', content: 'hi there', timestamp: 5, reference: 'p',
  });
  assert.equal(readPersonaFromEmbeds(history, { usernames: new Set(['bob']) }), 'bob');
});
