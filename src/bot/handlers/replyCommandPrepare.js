// Preparation of the reply command: the courtesy limit check, the target, and the modal.
import { MessageFlags } from 'discord.js';
import { SAFE_MENTIONS } from '../../discord/payload.js';
import { toMessageRecord } from '../../discord/messageRecord.js';
import { REPLY_COMMAND_NAME } from '../../discord/commands.js';
import {
  buildReplyModal, buildModalId, isModalTimeout, NOT_REPLYABLE_MESSAGE, WRONG_CHANNEL_MESSAGE, MODAL_TIMEOUT_LOG,
} from '../../discord/replyModal.js';
import { COMMAND_REFUSALS } from '../commandLimiter.js';

export const isReplyCommand = (interaction) =>
  interaction.isMessageContextMenuCommand() && interaction.commandName === REPLY_COMMAND_NAME;

export const refuse = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: SAFE_MENTIONS });

// A bot message is attributed to its persona, so the reply continues as that persona by default.
const describeTarget = ({ botMessageResolver }, message) => {
  const record = toMessageRecord(message);
  const bot = botMessageResolver.resolve(message);
  if (!bot) return { record, defaultAuthor: null };
  return { record: { ...record, author: bot.persona, content: bot.content }, defaultAuthor: bot.persona };
};

export const prepare = async (deps, interaction) => {
  const message = interaction.targetMessage;
  const { record, defaultAuthor } = describeTarget(deps, message);
  const target = deps.messageFilter.filterAnyAuthor(record);
  if (!target) return void (await refuse(interaction, NOT_REPLYABLE_MESSAGE));
  if (message.channel.id !== deps.config.discord.channelId) {
    return void (await refuse(interaction, WRONG_CHANNEL_MESSAGE));
  }
  return { target, message, channel: message.channel, defaultAuthor };
};

// Only a courtesy: the claim that counts is the one made when the modal is submitted.
export const isAllowed = async ({ commandLimiter }, interaction) => {
  const verdict = commandLimiter.check(interaction.user.id);
  if (verdict.allowed) return true;
  await refuse(interaction, COMMAND_REFUSALS[verdict.reason]);
  return false;
};

export const showModal = async ({ users, config }, interaction, prepared) => {
  const modalId = buildModalId(interaction.id);
  await interaction.showModal(buildReplyModal({
    record: prepared.target,
    users,
    modalId,
    defaultAuthor: prepared.defaultAuthor,
    previewChars: config.discord.modalPreviewChars,
  }));
  return modalId;
};

// Only this user's submission of this invocation's modal may resolve the wait.
export const awaitSubmit = async ({ config, logger }, interaction, modalId) => {
  const filter = (i) => i.customId === modalId && i.user.id === interaction.user.id;
  try {
    return await interaction.awaitModalSubmit({ time: config.discord.modalTimeoutMs, filter });
  } catch (error) {
    if (!isModalTimeout(error)) throw error;
    logger.info(MODAL_TIMEOUT_LOG);
    return null;
  }
};
