// The random auto-reply path of the message handler.
import { TRIGGERS } from '../../util/triggers.js';
import { DELIVERY_STAGE } from '../responder.js';
import { formatReply } from '../logLines.js';

// A failed send arms the rate limit so a persistent failure costs one LLM call per window.
export const respondTo = async ({ responder, replyPolicy }, { message, request }) => {
  try {
    return await responder.respond({
      ...request, guild: message.guild, channel: message.channel, via: { type: 'reply', message },
    });
  } catch (error) {
    if (error?.stage === DELIVERY_STAGE) replyPolicy.noteReply({ resetMisses: false });
    throw error;
  }
};

// A failure before anything was delivered rolls the activity back and cools the policy down.
const reply = async (deps, message, target) => {
  const { activity, replyPolicy, personaSelector } = deps;
  const undo = activity.noteBot();
  let delivered = false;
  try {
    const persona = await personaSelector.pickReplier(target);
    // Armed on the first part, so a message arriving mid-burst cannot trigger a second reply.
    const onDelivered = () => {
      delivered = true;
      replyPolicy.noteReply({ resetMisses: true });
      activity.noteBot();
    };
    const request = { trigger: TRIGGERS.AUTO, persona, target, onDelivered };
    const { response } = await respondTo(deps, { message, request });
    return formatReply({ persona, response });
  } catch (error) {
    if (!delivered) undo();
    if (error?.stage !== DELIVERY_STAGE) replyPolicy.noteFailure();
    throw error;
  }
};

// The slot is claimed by decide() and held until the whole attempt, burst included, is over.
export const autoReply = async (deps, { message, target, decision }) => {
  try {
    return await reply(deps, message, target);
  } finally {
    decision.release();
  }
};
