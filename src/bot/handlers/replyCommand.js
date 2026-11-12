import { MessageFlags } from 'discord.js';
import { toMessageRecord } from '../../discord/messageRecord.js';
import { REPLY_COMMAND_NAME } from '../../discord/commands.js';
import {
  buildReplyModal, readSelectedAuthor, REPLY_MODAL_ID, RANDOM_AUTHOR,
  NOT_REPLYABLE_MESSAGE, WRONG_CHANNEL_MESSAGE,
} from '../../discord/replyModal.js';
import { formatCommandRequest, formatReply } from '../logLines.js';

export const createReplyCommandHandler = (deps) => {
  const {
    client, config, users, messageFilter, personaSelector, composer,
    authorEmbeds, replyPolicy, activity, logger,
  } = deps;

  const isReplyCommand = (interaction) =>
    interaction.isMessageContextMenuCommand() && interaction.commandName === REPLY_COMMAND_NAME;

  const refuse = (interaction, content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });

  const chooseReplier = (modalInteraction, target) => {
    const selected = readSelectedAuthor(modalInteraction);
    return selected === RANDOM_AUTHOR ? personaSelector.pickReplier(target) : selected;
  };

  const awaitSubmit = async (interaction) => {
    try {
      return await interaction.awaitModalSubmit({ time: config.discord.modalTimeoutMs });
    } catch (error) {
      logger.error('Error handling modal submission:', error);
      return null;
    }
  };

  const answer = async ({ interaction, modalInteraction, target, guild }) => {
    const persona = await chooseReplier(modalInteraction, target);
    const thinking = await authorEmbeds.make(persona, guild, { thinking: true });
    await modalInteraction.reply({ embeds: [thinking] });
    const { response, payload } = await composer.composeReply({ persona, record: target, guild });
    await modalInteraction.editReply(payload);
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
    await interaction.showModal(buildReplyModal({ record: prepared.target, users }));
    const modalInteraction = await awaitSubmit(interaction);
    if (!modalInteraction || modalInteraction.customId !== REPLY_MODAL_ID) return;
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
