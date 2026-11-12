import { startTyping } from '../discord/typing.js';
import { burstDelay } from '../llm/burst.js';
import { TRIGGERS } from './triggers.js';
import { formatFailure } from './logLines.js';

export const DELIVERY_STAGE = 'delivery';
export const GENERATION_STAGE = 'generation';

const NO_TYPING = Object.freeze({ pulse: () => {}, stop: () => {} });

// Lets handlers tell a send failure (arm the rate limit) from a generation failure, and say whose work failed.
// The caught error is wrapped, never mutated.
const tagFailure = (error, { stage, persona, trigger }) => {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message, { cause: error }), { stage, persona, trigger });
};

export const createResponder = ({
  composer, delivery, contextBuilder, botMessageStore, clock, config, logger,
}) => {
  const now = () => clock.now();

  const record = ({ message, text, persona, target, trigger }) => {
    if (!message?.id) {
      logger.warn(`Sent message has no id; bot message not recorded (${trigger}, ${persona})`);
      return;
    }
    try {
      botMessageStore.insert({
        id: message.id,
        persona,
        content: text,
        timestamp: message.createdTimestamp ?? now(),
        reference: target?.id ?? null,
        trigger,
      });
    } catch (error) {
      logger.error(`Could not record bot message ${message.id}:`, error);
    }
  };

  // A failed revive context degrades to none: the revive is still sent.
  const reviveContext = async (channel) => {
    try {
      return await contextBuilder.forRevive({ channel, nowMs: now() });
    } catch (error) {
      logger.warn('Could not build revive context; continuing without it:', error);
      return {};
    }
  };

  // A failed transcript degrades to none, like a failed history fetch: the reply is still sent.
  const replyContext = async ({ channel, target }) => {
    try {
      return await contextBuilder.forReply({ channel, target });
    } catch (error) {
      logger.warn(`Could not build the transcript for ${target.id}; continuing without it:`, error);
      return { transcript: [] };
    }
  };

  const contextFor = (request) => {
    if (request.chain) return { chain: request.chain };
    return request.target === null ? reviveContext(request.channel) : replyContext(request);
  };

  // The interaction shows its own placeholder, so the command trigger does not type.
  const beginTyping = ({ trigger, channel }) => {
    if (!config.typing.enabled || trigger === TRIGGERS.COMMAND) return NO_TYPING;
    return startTyping(channel, { clock, refreshMs: config.typing.refreshMs, logger });
  };

  // Later parts go out as plain messages (or follow-ups) so only the first can ping the replied user.
  const laterVia = ({ trigger, via, channel }) =>
    (trigger === TRIGGERS.COMMAND ? { type: 'followUp', interaction: via.interaction } : { type: 'channel', channel });

  const send = async ({ via, request, part }) => {
    const { persona, guild, channel, trigger } = request;
    try {
      return await delivery.deliver({
        via, persona, guild, channel, content: part.content, gifLinks: part.gifLinks,
      });
    } catch (error) {
      throw tagFailure(error, { stage: DELIVERY_STAGE, persona, trigger });
    }
  };

  const deliverPart = async (request, via, part) => {
    const { persona, target, trigger } = request;
    const message = await send({ via, request, part });
    record({ message, text: part.text, persona, target, trigger });
    return message;
  };

  const deliverLater = async (request, part, typing) => {
    typing.pulse();
    await clock.sleep(burstDelay(part.text, config.burst));
    return deliverPart(request, laterVia(request), part);
  };

  // A failure after the first part is logged and ends the burst; the reply already went out.
  const deliverRest = async (request, parts, typing) => {
    const messages = [];
    try {
      for (const part of parts) messages.push(await deliverLater(request, part, typing));
    } catch (error) {
      logger.error(formatFailure({
        what: 'Could not deliver a later part of the burst',
        trigger: request.trigger,
        persona: request.persona,
        stage: DELIVERY_STAGE,
      }), error);
    }
    return messages;
  };

  const deliverAll = async (request, parts, typing) => {
    const [first, ...rest] = parts;
    const message = await deliverPart(request, request.via, first);
    request.onDelivered?.();
    return [message, ...await deliverRest(request, rest, typing)];
  };

  const generate = async (request) => {
    try {
      const context = await contextFor(request);
      return await composer.compose({ persona: request.persona, target: request.target, context });
    } catch (error) {
      throw tagFailure(error, { stage: GENERATION_STAGE, persona: request.persona, trigger: request.trigger });
    }
  };

  const respond = async (request) => {
    const typing = beginTyping(request);
    try {
      const { response, parts } = await generate(request);
      const messages = await deliverAll(request, parts, typing);
      return { response, messages };
    } finally {
      typing.stop();
    }
  };

  return { respond };
};
