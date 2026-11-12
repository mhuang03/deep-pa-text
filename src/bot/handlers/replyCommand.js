import { MessageFlags } from 'discord.js';
import { TRIGGERS } from '../triggers.js';
import { withSafeMentions, SAFE_MENTIONS } from '../../discord/payload.js';
import { toMessageRecord } from '../../discord/messageRecord.js';
import { REPLY_COMMAND_NAME } from '../../discord/commands.js';
import {
  buildReplyModal, buildModalId, readSelectedAuthor, isModalTimeout, RANDOM_AUTHOR,
  NOT_REPLYABLE_MESSAGE, WRONG_CHANNEL_MESSAGE, MODAL_TIMEOUT_LOG, GENERATION_FAILED_MESSAGE,
} from '../../discord/replyModal.js';
import { formatCommandRequest, formatReply } from '../logLines.js';

export const createReplyCommandHandler = (deps) => {
  const {
    client, config, users, messageFilter, personaSelector, responder,
    authorEmbeds, replyPolicy, activity, logger,
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

  const deliverReply = async ({ modalInteraction, persona, target, guild }) => {
    const { response } = await responder.respond({
      trigger: TRIGGERS.COMMAND,
      persona,
      target,
      guild,
      via: { type: 'interaction', interaction: modalInteraction },
    });
    return response;
  };

  const answer = async ({ interaction, modalInteraction, target, guild }) => {
    const persona = await chooseReplier(modalInteraction, target);
    const thinking = await authorEmbeds.make(persona, guild, { thinking: true });
    await modalInteraction.reply(withSafeMentions({ embeds: [thinking] }));
    let response;
    try {
      response = await deliverReply({ modalInteraction, persona, target, guild });
    } catch (error) {
      await notifyFailure(modalInteraction);
      throw error;
    }
    logger.info(formatCommandRequest({
      requester: interaction.user.username, record: target, logging: config.logging,
    }));
    logger.info(formatReply({ persona, response }));
    replyPolicy.noteReply({ resetMisses: false });
    activity.noteBot();
  };

  const prepare = async (interaction) => {
    const message = interaction.targetMessage;
    const target = messageFilter.filterAnyAuthor(toMessageRecord(message));
    if (!target) return void (await refuse(interaction, NOT_REPLYABLE_MESSAGE));
    const guild = message.guild ?? await client.guilds.fetch(message.guildId);
    if (message.channel.id !== config.discord.channelId) {
      return void (await refuse(interaction, WRONG_CHANNEL_MESSAGE));
    }
    return { target, guild };
  };

  const run = async (interaction) => {
    const prepared = await prepare(interaction);
    if (!prepared) return;
    const modalId = buildModalId(interaction.id);
    await interaction.showModal(buildReplyModal({ record: prepared.target, users, modalId }));
    const modalInteraction = await awaitSubmit(interaction, modalId);
    if (!modalInteraction) return;
    await answer({ interaction, modalInteraction, ...prepared });
  };

  return async (interaction) => {
    try {
      if (!isReplyCommand(interaction)) return;
      await run(interaction);
    } catch (error) {
      logger.error('Error handling reply command:', error);
    }
  };
};
