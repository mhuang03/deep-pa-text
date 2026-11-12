import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LabelBuilder, ModalBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextDisplayBuilder,
} from 'discord.js';
import {
  AUTHOR_SELECT_ID, RANDOM_AUTHOR, REPLY_MODAL_PREFIX, buildReplyModal, buildModalId, isModalTimeout,
  readSelectedAuthor, MODAL_TIMEOUT_LOG,
} from '../../../src/discord/replyModal.js';
import { USERS } from '../../support/fixtures.js';

// Mirrors the builder calls in legacy bot.js.
const buildLegacyModal = (msg, users, modalId) => {
  const options = users.map((user) => new StringSelectMenuOptionBuilder()
    .setLabel(user.username).setDescription(`Reply as ${user.name}`).setValue(user.username));
  options.push(new StringSelectMenuOptionBuilder()
    .setLabel('random').setDescription('Reply as a random user').setValue('random'));
  const display = new TextDisplayBuilder().setContent(`**Original message from ${msg.author}:**\n${msg.content}`);
  const select = new StringSelectMenuBuilder()
    .setCustomId('authorSelect').setPlaceholder('Select an author').addOptions(options);
  const label = new LabelBuilder().setLabel('Who should I reply as?').setStringSelectMenuComponent(select);
  return new ModalBuilder().setCustomId(modalId).setTitle('Reply using deep pa-text')
    .addTextDisplayComponents(display).addLabelComponents(label);
};

const record = { id: 'm1', author: 'carol', content: 'hello **there**', timestamp: 1, reference: null };

test('exports the identifiers', () => {
  assert.deepEqual([REPLY_MODAL_PREFIX, AUTHOR_SELECT_ID, RANDOM_AUTHOR], ['replyModal', 'authorSelect', 'random']);
  assert.equal(MODAL_TIMEOUT_LOG, 'reply modal dismissed or timed out');
});

test('modal JSON equals the legacy builder output', () => {
  const modal = buildReplyModal({ record, users: USERS, modalId: 'replyModal:i1' });
  assert.deepEqual(modal.toJSON(), buildLegacyModal(record, USERS, 'replyModal:i1').toJSON());
});

test('modal JSON has the pinned shape', () => {
  const json = buildReplyModal({ record, users: USERS, modalId: 'replyModal:i1' }).toJSON();
  assert.equal(json.custom_id, 'replyModal:i1');
  assert.equal(json.title, 'Reply using deep pa-text');
  assert.equal(json.components.length, 2);
  assert.equal(json.components[0].content, '**Original message from carol:**\nhello **there**');
  const label = json.components[1];
  assert.equal(label.label, 'Who should I reply as?');
  assert.equal(label.component.custom_id, 'authorSelect');
  assert.equal(label.component.placeholder, 'Select an author');
  assert.deepEqual(JSON.parse(JSON.stringify(label.component.options)), [
    ...USERS.map((u) => ({ label: u.username, description: `Reply as ${u.name}`, value: u.username })),
    { label: 'random', description: 'Reply as a random user', value: 'random' },
  ]);
});

test('with no users only the random option is offered', () => {
  const json = buildReplyModal({ record, users: [], modalId: 'replyModal:i1' }).toJSON();
  assert.deepEqual(json.components[1].component.options.map((o) => o.value), ['random']);
});

test('readSelectedAuthor returns the first selected value', () => {
  const calls = [];
  const modalInteraction = {
    fields: { getStringSelectValues: (id) => (calls.push(id), ['bob', 'ignored']) },
  };
  assert.equal(readSelectedAuthor(modalInteraction), 'bob');
  assert.deepEqual(calls, ['authorSelect']);
});

test('buildModalId prefixes the interaction id', () => {
  assert.equal(buildModalId('123'), 'replyModal:123');
});

test('buildReplyModal uses the given modal id', () => {
  assert.equal(buildReplyModal({ record, users: USERS, modalId: 'replyModal:zzz' }).toJSON().custom_id, 'replyModal:zzz');
});

test('isModalTimeout is true only for collector errors', () => {
  assert.equal(isModalTimeout(Object.assign(new Error('x'), { code: 'InteractionCollectorError' })), true);
  assert.equal(isModalTimeout(new Error('x')), false);
  assert.equal(isModalTimeout(null), false);
  assert.equal(isModalTimeout(undefined), false);
});

test('defaultAuthor marks only that persona option as the default', () => {
  const json = buildReplyModal({ record, users: USERS, modalId: 'm', defaultAuthor: 'bob' }).toJSON();
  const options = json.components[1].component.options;
  assert.deepEqual(options.filter((o) => o.default).map((o) => o.value), ['bob']);
});

test('an unknown defaultAuthor marks nothing', () => {
  const json = buildReplyModal({ record, users: USERS, modalId: 'm', defaultAuthor: 'zed' }).toJSON();
  assert.equal(json.components[1].component.options.some((o) => o.default), false);
});
