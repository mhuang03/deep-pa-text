import {
  ModalBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  LabelBuilder, TextDisplayBuilder,
} from 'discord.js';

export const REPLY_MODAL_PREFIX = 'replyModal';
export const AUTHOR_SELECT_ID = 'authorSelect';
export const RANDOM_AUTHOR = 'random';

export const MODAL_TITLE = 'Reply using deep pa-text';
export const AUTHOR_LABEL = 'Who should I reply as?';
export const AUTHOR_PLACEHOLDER = 'Select an author';
export const RANDOM_DESCRIPTION = 'Reply as a random user';
export const NOT_REPLYABLE_MESSAGE = 'The selected message is not replyable.';
export const MODAL_TIMEOUT_LOG = 'reply modal dismissed or timed out';
export const WRONG_CHANNEL_MESSAGE = 'This command can only be used in the #pa-text channel.';

const buildUserOption = (user) =>
  new StringSelectMenuOptionBuilder()
    .setLabel(user.username)
    .setDescription(`Reply as ${user.name}`)
    .setValue(user.username);

const buildRandomOption = () =>
  new StringSelectMenuOptionBuilder()
    .setLabel(RANDOM_AUTHOR)
    .setDescription(RANDOM_DESCRIPTION)
    .setValue(RANDOM_AUTHOR);

const buildAuthorLabel = (users) => {
  const select = new StringSelectMenuBuilder()
    .setCustomId(AUTHOR_SELECT_ID)
    .setPlaceholder(AUTHOR_PLACEHOLDER)
    .addOptions([...users.map(buildUserOption), buildRandomOption()]);
  return new LabelBuilder().setLabel(AUTHOR_LABEL).setStringSelectMenuComponent(select);
};

export const buildModalId = (interactionId) => `${REPLY_MODAL_PREFIX}:${interactionId}`;

// discord.js rejects a modal wait with this code when time runs out.
export const isModalTimeout = (error) => error?.code === 'InteractionCollectorError';

export const buildReplyModal = ({ record, users, modalId }) => {
  const display = new TextDisplayBuilder()
    .setContent(`**Original message from ${record.author}:**\n${record.content}`);
  return new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(MODAL_TITLE)
    .addTextDisplayComponents(display)
    .addLabelComponents(buildAuthorLabel(users));
};

export const readSelectedAuthor = (modalInteraction) =>
  modalInteraction.fields.getStringSelectValues(AUTHOR_SELECT_ID)[0];
