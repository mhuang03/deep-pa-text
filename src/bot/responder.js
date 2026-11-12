import { startTyping } from '../discord/typing.js';
import { TRIGGERS } from './triggers.js';
import { GENERATION_STAGE, tagFailure } from './responderFailure.js';
import { createContextResolver } from './responderContext.js';
import { createBotMessageRecorder } from './responderRecord.js';
import { createPartDelivery } from './responderDelivery.js';

export { DELIVERY_STAGE } from './responderFailure.js';

const NO_TYPING = Object.freeze({ pulse: () => {}, stop: () => {} });

// The interaction shows its own placeholder, so the command trigger does not type.
const beginTyping = ({ clock, config, logger }, { trigger, channel }) => {
  if (!config.typing.enabled || trigger === TRIGGERS.COMMAND) return NO_TYPING;
  return startTyping(channel, { clock, refreshMs: config.typing.refreshMs, logger });
};

const generate = async ({ composer, resolver }, request) => {
  try {
    const context = await resolver.contextFor(request);
    return await composer.compose({ persona: request.persona, target: request.target, context });
  } catch (error) {
    throw tagFailure(error, { stage: GENERATION_STAGE, persona: request.persona, trigger: request.trigger });
  }
};

export const createResponder = ({
  composer, delivery, contextBuilder, botMessageStore, clock, config, logger,
}) => {
  const resolver = createContextResolver({ contextBuilder, clock, logger });
  const { record } = createBotMessageRecorder({ botMessageStore, clock, logger });
  const parts = createPartDelivery({ delivery, record, clock, config, logger });

  const respond = async (request) => {
    const typing = beginTyping({ clock, config, logger }, request);
    try {
      const { response, parts: toSend } = await generate({ composer, resolver }, request);
      const messages = await parts.deliverAll(request, { parts: toSend, typing });
      return { response, messages };
    } finally {
      typing.stop();
    }
  };

  return { respond };
};
