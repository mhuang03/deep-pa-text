import { MessageFlags } from 'discord.js';
import { TRIGGERS } from '../triggers.js';
import { SAFE_MENTIONS } from '../../discord/payload.js';
import { toMessageRecord } from '../../discord/messageRecord.js';
import { REPLY_COMMAND_NAME } from '../../discord/commands.js';
import {
  buildReplyModal, buildModalId, readSelectedAuthor, isModalTimeout, RANDOM_AUTHOR,
  NOT_REPLYABLE_MESSAGE, WRONG_CHANNEL_MESSAGE, MODAL_TIMEOUT_LOG, GENERATION_FAILED_MESSAGE,
} from '../../discord/replyModal.js';
import { COMMAND_REFUSALS } from '../commandLimiter.js';
import { formatCommandRequest, formatReply, formatFailure } from '../logLines.js';

export const createReplyCommandHandler = (deps) => {
  const {
    client, config, users, messageFilter, personaSelector, responder,
    delivery, replyPolicy, botMessageResolver, commandLimiter, logger,
  } = deps;

  const isReplyCommand = (interaction) =>
    interaction.isMessageContextMenuCommand() && interaction.commandName === REPLY_COMMAND_NAME;

  const refuse = (interaction, content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: SAFE_MENTIONS });

  const chooseReplier = (modalInteraction, target) => {
    const selected = readSelectedAuthor(modalInteraction);
    return selected === RANDOM_AUTHOR ? personaSelector.pickReplier(target) : selected;
  };

  // Only this user's submission of this invocation's modal may resolve the wait.
  const awaitSubmit = async (interaction, modalId) => {
    const filter = (i) => i.customId === modalId && i.user.id === interaction.user.id;
    try {
      return await interaction.awaitModalSubmit({ time: config.discord.modalTimeoutMs, filter });
    } catch (error) {
      if (!isModalTimeout(error)) throw error;
      logger.info(MODAL_TIMEOUT_LOG);
      return null;
    }
  };

  // Best effort: the placeholder must not stay on "thinking..." when the reply fails.
  const notifyFailure = async (modalInteraction) => {
    try {
      await modalInteraction.editReply({
        content: GENERATION_FAILED_MESSAGE, embeds: [], allowedMentions: SAFE_MENTIONS,
      });
    } catch (error) {
      logger.error('Could not report the failed reply:', error);
    }
  };

  const deliverReply = async ({ modalInteraction, persona, target, guild, channel, onDelivered }) => {
    const { response } = await responder.respond({
      trigger: TRIGGERS.COMMAND,
      persona,
      target,
      guild,
      channel,
      via: { type: 'interaction', interaction: modalInteraction },
      onDelivered,
    });
    return response;
  };

  const logOutcome = ({ interaction, target, persona, response }) => {
    logger.info(formatCommandRequest({
      requester: interaction.user.username, record: target, logging: config.logging,
    }));
    logger.info(formatReply({ persona, response }));
  };

  // Everything slow happens here, after the submission has been acknowledged.
  const generateAndEdit = async ({ interaction, modalInteraction, prepared }) => {
    const { target, channel, message } = prepared;
    try {
      const guild = message.guild ?? await client.guilds.fetch(message.guildId);
      const persona = await chooseReplier(modalInteraction, target);
      await modalInteraction.editReply(await delivery.placeholder({ persona, guild }));
      const onDelivered = () => replyPolicy.noteReply({ resetMisses: false });
      const response = await deliverReply({ modalInteraction, persona, target, guild, channel, onDelivered });
      logOutcome({ interaction, target, persona, response });
    } catch (error) {
      await notifyFailure(modalInteraction);
      throw error;
    }
  };

  // The limiter is released whatever happens, including a failed acknowledgement.
  const answer = async ({ interaction, modalInteraction, prepared }) => {
    const begun = commandLimiter.begin(interaction.user.id);
    if (!begun.allowed) return void (await refuse(modalInteraction, COMMAND_REFUSALS[begun.reason]));
    try {
      await modalInteraction.deferReply(delivery.deferOptions());
      await generateAndEdit({ interaction, modalInteraction, prepared });
    } finally {
      commandLimiter.end();
    }
  };

  // A bot message is attributed to its persona, so the reply continues as that persona by default.
  const describeTarget = (message) => {
    const record = toMessageRecord(message);
    const bot = botMessageResolver.resolve(message);
    if (!bot) return { record, defaultAuthor: null };
    return { record: { ...record, author: bot.persona, content: bot.content }, defaultAuthor: bot.persona };
  };

  const prepare = async (interaction) => {
    const message = interaction.targetMessage;
    const { record, defaultAuthor } = describeTarget(message);
    const target = messageFilter.filterAnyAuthor(record);
    if (!target) return void (await refuse(interaction, NOT_REPLYABLE_MESSAGE));
    if (message.channel.id !== config.discord.channelId) {
      return void (await refuse(interaction, WRONG_CHANNEL_MESSAGE));
    }
    return { target, message, channel: message.channel, defaultAuthor };
  };

  // Only a courtesy: the claim that counts is the one made when the modal is submitted.
  const isAllowed = async (interaction) => {
    const verdict = commandLimiter.check(interaction.user.id);
    if (verdict.allowed) return true;
    await refuse(interaction, COMMAND_REFUSALS[verdict.reason]);
    return false;
  };

  const showModal = async (interaction, prepared) => {
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

  const run = async (interaction) => {
    if (!await isAllowed(interaction)) return;
    const prepared = await prepare(interaction);
    if (!prepared) return;
    const modalId = await showModal(interaction, prepared);
    const modalInteraction = await awaitSubmit(interaction, modalId);
    if (!modalInteraction) return;
    await answer({ interaction, modalInteraction, prepared });
  };

  return async (interaction) => {
    try {
      if (!isReplyCommand(interaction)) return;
      await run(interaction);
    } catch (error) {
      logger.error(formatFailure({
        what: 'Error handling reply command',
        messageId: interaction.targetMessage?.id,
        trigger: error?.trigger,
        persona: error?.persona,
        stage: error?.stage,
      }), error);
    }
  };
};
