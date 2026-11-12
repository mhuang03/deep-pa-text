import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { createBotMessageStore } from '../../../src/storage/botMessageStore.js';
import { createProfileStore } from '../../../src/storage/profileStore.js';
import { buildUserDirectory } from '../../../src/userData/loadData.js';
import { createBotMessageImporter, splitReplyLink } from '../../../src/backfill/botMessageImporter.js';
import { REPLY_LINK_PREFIX } from '../../../src/discord/webhookDelivery.js';

const USERS = [
  { username: 'alice', name: 'Alice Example' },
  { username: 'bob', name: 'Bob Example' },
  { username: 'carol', name: 'Carol Example' },
];

const setup = () => {
  const db = openDatabase(':memory:');
  const botMessageStore = createBotMessageStore({ db, config: { burst: { siblingWindowMs: 1000 } } });
  const profileStore = createProfileStore({ db });
  const infos = [];
  const importer = createBotMessageImporter({
    botMessageStore, profileStore, userDirectory: buildUserDirectory(USERS),
    config: { discord: { webhookUsernameMax: 10 } }, logger: { info: (...a) => infos.push(a) },
  });
  return { importer, botMessageStore, profileStore, infos };
};

const embedMessage = (id, persona, content = 'hello there', extra = {}) => ({
  id, content, createdTimestamp: 100, webhookId: null, reference: null,
  author: { id: 'bot', username: 'deep-pa-text', bot: true },
  embeds: [{ author: { name: persona } }], ...extra,
});
const hookMessage = (id, name, content = 'hello there', extra = {}) => ({
  id, content, createdTimestamp: 200, webhookId: 'wh', reference: null,
  author: { id: 'wh', username: name, bot: true }, embeds: [], ...extra,
});

test('imports an embed-mode message with the persona from the embed and trigger imported', () => {
  const { importer, botMessageStore } = setup();
  const counts = importer.run([embedMessage('1', 'alice', 'hi', { reference: { messageId: 'p' } })]);
  assert.deepEqual(counts, { imported: 1, alreadyStored: 0, unattributed: 0, skippedEmpty: 0 });
  assert.deepEqual(botMessageStore.getById('1'), {
    id: '1', persona: 'alice', content: 'hi', timestamp: 100, reference: 'p', trigger: 'imported',
  });
});

test('lookup rows take precedence for persona, content, reference and trigger', () => {
  const { importer, botMessageStore } = setup();
  const known = { persona: 'bob', content: 'kept <gif! cat>', reference: 'r', trigger: 'chain' };
  importer.run([embedMessage('1', 'alice', 'discord text')], { lookup: (id) => (id === '1' ? known : null) });
  assert.deepEqual(botMessageStore.getById('1'), {
    id: '1', persona: 'bob', content: 'kept <gif! cat>', timestamp: 100, reference: 'r', trigger: 'chain',
  });
});

test('a webhook message strips the reply-link line and takes the reference from the link', () => {
  const { importer, botMessageStore, profileStore } = setup();
  profileStore.record({ username: 'alice', displayName: 'Alice D', observedAt: 1 });
  const content = `${REPLY_LINK_PREFIX}https://discord.test/channels/1/2/777\nthe reply text`;
  importer.run([hookMessage('1', 'Alice D', content)]);
  const row = botMessageStore.getById('1');
  assert.equal(row.content, 'the reply text');
  assert.equal(row.reference, '777');
  assert.equal(row.persona, 'alice');
});

test('a webhook name is matched against the username, the current and the past display names, cut to the limit', () => {
  const { importer, botMessageStore, profileStore } = setup();
  profileStore.record({ username: 'carol', displayName: 'Old Carol Display', observedAt: 1 });
  profileStore.record({ username: 'carol', displayName: 'New Carol', observedAt: 2 });
  importer.run([hookMessage('1', 'bob'), hookMessage('2', 'Old Carol '), hookMessage('3', 'New Carol')]);
  assert.deepEqual(['1', '2', '3'].map((id) => botMessageStore.getById(id)?.persona), ['bob', 'carol', 'carol']);
});

test('an ambiguous or unknown webhook name is unattributed and skipped', () => {
  const { importer, botMessageStore, profileStore, infos } = setup();
  profileStore.record({ username: 'alice', displayName: 'Shared', observedAt: 1 });
  profileStore.record({ username: 'bob', displayName: 'Shared', observedAt: 1 });
  const counts = importer.run([hookMessage('1', 'Shared'), hookMessage('2', 'Nobody')]);
  assert.equal(counts.unattributed, 2);
  assert.equal(counts.imported, 0);
  assert.equal(botMessageStore.getById('1'), null);
  assert.equal(infos.length, 2);
});

test('a non-webhook message without a persona source is unattributed even if its name matches a user', () => {
  const { importer } = setup();
  const message = embedMessage('1', 'nobody', 'x', { author: { id: 'bot', username: 'alice', bot: true } });
  assert.equal(importer.run([message]).unattributed, 1);
});

test('a message with no content is skipped as empty', () => {
  const { importer, botMessageStore } = setup();
  const counts = importer.run([embedMessage('1', 'alice', ''), hookMessage('2', 'bob', `${REPLY_LINK_PREFIX}https://x/y/9`)]);
  assert.equal(counts.skippedEmpty, 2);
  assert.equal(botMessageStore.getById('1'), null);
});

test('a message already in bot_messages is counted and left untouched, soft-deleted ones too', () => {
  const { importer, botMessageStore } = setup();
  botMessageStore.insert({ id: '1', persona: 'bob', content: 'original', timestamp: 1, trigger: 'auto' });
  botMessageStore.insert({ id: '2', persona: 'bob', content: 'gone', timestamp: 1, trigger: 'auto' });
  botMessageStore.softDelete('2', 5);
  const counts = importer.run([embedMessage('1', 'alice'), embedMessage('2', 'alice')]);
  assert.equal(counts.alreadyStored, 2);
  assert.equal(botMessageStore.getById('1').content, 'original');
});

test('a dry run counts without writing', () => {
  const { importer, botMessageStore } = setup();
  const counts = importer.run([embedMessage('1', 'alice')], { dryRun: true });
  assert.equal(counts.imported, 1);
  assert.equal(botMessageStore.getById('1'), null);
});

test('splitReplyLink leaves content without the prefix alone and uses the Discord reference', () => {
  assert.deepEqual(splitReplyLink({ content: 'plain', reference: { messageId: 'r' } }), { text: 'plain', reference: 'r' });
  assert.deepEqual(splitReplyLink({ content: 'plain', reference: null }), { text: 'plain', reference: null });
});
