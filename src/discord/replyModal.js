import {
  ModalBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  LabelBuilder, TextDisplayBuilder,
} from 'discord.js';

export const REPLY_MODAL_PREFIX = 'replyModal';
export const AUTHOR_SELECT_ID = 'authorSelect';
export const RANDOM_AUTHOR = 'random';
// Discord allows 25 select options; one is kept for 'random'.
export const MODAL_MAX_USERS = 24;
export const PREVIEW_ELLIPSIS = '…';

export const MODAL_TITLE = 'Reply using deep pa-text';
export const AUTHOR_LABEL = 'Who should I reply as?';
export const AUTHOR_PLACEHOLDER = 'Select an author';
export const RANDOM_DESCRIPTION = 'Reply as a random user';
export const NOT_REPLYABLE_MESSAGE = 'The selected message is not replyable.';
export const MODAL_TIMEOUT_LOG = 'reply modal dismissed or timed out';
export const GENERATION_FAILED_MESSAGE = 'Could not generate a reply.';
export const WRONG_CHANNEL_MESSAGE = 'This command can only be used in the #pa-text channel.';

const buildUserOption = (user, defaultAuthor) => {
  const option = new StringSelectMenuOptionBuilder()
    .setLabel(user.username)
    .setDescription(`Reply as ${user.name}`)
    .setValue(user.username);
  return user.username === defaultAuthor ? option.setDefault(true) : option;
};

const buildRandomOption = () =>
  new StringSelectMenuOptionBuilder()
    .setLabel(RANDOM_AUTHOR)
    .setDescription(RANDOM_DESCRIPTION)
    .setValue(RANDOM_AUTHOR);

// With too many users the default persona comes first, then the directory order, so it is never cut.
export const selectModalUsers = (users, defaultAuthor) => {
  if (users.length <= MODAL_MAX_USERS) return users;
  const preferred = users.filter((user) => user.username === defaultAuthor);
  const rest = users.filter((user) => user.username !== defaultAuthor);
  return [...preferred, ...rest].slice(0, MODAL_MAX_USERS);
};

// Cut by code points so an emoji is never split.
export const truncatePreview = (content, maxChars) => {
  const points = [...content];
  return points.length <= maxChars ? content : `${points.slice(0, maxChars).join('')}${PREVIEW_ELLIPSIS}`;
};

const buildAuthorLabel = (users, defaultAuthor) => {
  const select = new StringSelectMenuBuilder()
    .setCustomId(AUTHOR_SELECT_ID)
    .setPlaceholder(AUTHOR_PLACEHOLDER)
    .addOptions([...selectModalUsers(users, defaultAuthor).map((user) => buildUserOption(user, defaultAuthor)), buildRandomOption()]);
  return new LabelBuilder().setLabel(AUTHOR_LABEL).setStringSelectMenuComponent(select);
};

export const buildModalId = (interactionId) => `${REPLY_MODAL_PREFIX}:${interactionId}`;

// discord.js rejects a modal wait with this code when time runs out.
export const isModalTimeout = (error) => error?.code === 'InteractionCollectorError';

export const buildReplyModal = ({
  record, users, modalId, defaultAuthor = null, previewChars = Infinity,
}) => {
  const preview = truncatePreview(record.content, previewChars);
  const display = new TextDisplayBuilder()
    .setContent(`**Original message from ${record.author}:**\n${preview}`);
  return new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(MODAL_TITLE)
    .addTextDisplayComponents(display)
    .addLabelComponents(buildAuthorLabel(users, defaultAuthor));
};

export const readSelectedAuthor = (modalInteraction) =>
  modalInteraction.fields.getStringSelectValues(AUTHOR_SELECT_ID)[0];
