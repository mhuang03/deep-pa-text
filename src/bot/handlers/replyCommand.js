import { formatFailure } from '../logLines.js';
import {
  isReplyCommand, prepare, isAllowed, showModal, awaitSubmit,
} from './replyCommandPrepare.js';
import { answer } from './replyCommandAnswer.js';

const run = async (deps, interaction) => {
  if (!await isAllowed(deps, interaction)) return;
  const prepared = await prepare(deps, interaction);
  if (!prepared) return;
  const modalId = await showModal(deps, interaction, prepared);
  const modalInteraction = await awaitSubmit(deps, interaction, modalId);
  if (!modalInteraction) return;
  await answer(deps, { interaction, modalInteraction, prepared });
};

export const createReplyCommandHandler = (deps) => async (interaction) => {
  try {
    if (!isReplyCommand(interaction)) return;
    await run(deps, interaction);
  } catch (error) {
    deps.logger.error(formatFailure({
      what: 'Error handling reply command',
      messageId: interaction.targetMessage?.id,
      trigger: error?.trigger,
      persona: error?.persona,
      stage: error?.stage,
    }), error);
  }
};
