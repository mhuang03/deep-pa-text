// Answering a submitted reply modal: acknowledge, choose the persona, respond, and report failures.
import { TRIGGERS } from '../triggers.js';
import { SAFE_MENTIONS } from '../../discord/payload.js';
import { readSelectedAuthor, RANDOM_AUTHOR, GENERATION_FAILED_MESSAGE } from '../../discord/replyModal.js';
import { COMMAND_REFUSALS } from '../commandLimiter.js';
import { formatCommandRequest, formatReply } from '../logLines.js';
import { refuse } from './replyCommandPrepare.js';

const chooseReplier = ({ personaSelector }, modalInteraction, target) => {
  const selected = readSelectedAuthor(modalInteraction);
  return selected === RANDOM_AUTHOR ? personaSelector.pickReplier(target) : selected;
};

// Best effort: the placeholder must not stay on "thinking..." when the reply fails.
const notifyFailure = async ({ logger }, modalInteraction) => {
  try {
    await modalInteraction.editReply({
      content: GENERATION_FAILED_MESSAGE, embeds: [], allowedMentions: SAFE_MENTIONS,
    });
  } catch (error) {
    logger.error('Could not report the failed reply:', error);
  }
};

const deliverReply = async ({ responder }, request) => {
  const { modalInteraction, ...rest } = request;
  const { response } = await responder.respond({
    trigger: TRIGGERS.COMMAND,
    ...rest,
    via: { type: 'interaction', interaction: modalInteraction },
  });
  return response;
};

const logOutcome = ({ config, logger }, { interaction, target, persona, response }) => {
  logger.info(formatCommandRequest({
    requester: interaction.user.username, record: target, logging: config.logging,
  }));
  logger.info(formatReply({ persona, response }));
};

// Everything slow happens here, after the submission has been acknowledged.
const generateAndEdit = async (deps, { interaction, modalInteraction, prepared }) => {
  const { target, channel, message } = prepared;
  try {
    const guild = message.guild ?? await deps.client.guilds.fetch(message.guildId);
    const persona = await chooseReplier(deps, modalInteraction, target);
    await modalInteraction.editReply(await deps.delivery.placeholder({ persona, guild }));
    const onDelivered = () => deps.replyPolicy.noteReply({ resetMisses: false });
    const response = await deliverReply(deps, { modalInteraction, persona, target, guild, channel, onDelivered });
    logOutcome(deps, { interaction, target, persona, response });
  } catch (error) {
    await notifyFailure(deps, modalInteraction);
    throw error;
  }
};

// The limiter is released whatever happens, including a failed acknowledgement.
export const answer = async (deps, { interaction, modalInteraction, prepared }) => {
  const { commandLimiter, delivery } = deps;
  const begun = commandLimiter.begin(interaction.user.id);
  if (!begun.allowed) return void (await refuse(modalInteraction, COMMAND_REFUSALS[begun.reason]));
  try {
    await modalInteraction.deferReply(delivery.deferOptions());
    await generateAndEdit(deps, { interaction, modalInteraction, prepared });
  } finally {
    commandLimiter.end();
  }
};
