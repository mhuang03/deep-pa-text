import { burstDelay } from '../llm/burst.js';
import { TRIGGERS } from '../util/triggers.js';
import { formatFailure } from './logLines.js';
import { DELIVERY_STAGE, tagFailure } from './responderFailure.js';

// Later parts go out as plain messages (or follow-ups) so only the first can ping the replied user.
const laterVia = ({ trigger, via, channel }) =>
  (trigger === TRIGGERS.COMMAND ? { type: 'followUp', interaction: via.interaction } : { type: 'channel', channel });

const send = async ({ delivery }, { via, request, part }) => {
  const { persona, guild, channel, trigger } = request;
  try {
    return await delivery.deliver({
      via, persona, guild, channel, content: part.content, gifLinks: part.gifLinks,
    });
  } catch (error) {
    throw tagFailure(error, { stage: DELIVERY_STAGE, persona, trigger });
  }
};

const deliverPart = async (ctx, request, { via, part }) => {
  const { persona, target, trigger, conversation } = request;
  const message = await send(ctx, { via, request, part });
  ctx.record({ message, text: part.text, persona, target, trigger, conversation });
  return message;
};

const deliverLater = async (ctx, request, { part, typing }) => {
  typing.pulse();
  await ctx.clock.sleep(burstDelay(part.text, ctx.config.burst));
  return deliverPart(ctx, request, { via: laterVia(request), part });
};

// A failure after the first part is logged and ends the burst; the reply already went out.
const deliverRest = async (ctx, request, { parts, typing }) => {
  const messages = [];
  try {
    for (const part of parts) messages.push(await deliverLater(ctx, request, { part, typing }));
  } catch (error) {
    ctx.logger.error(formatFailure({
      what: 'Could not deliver a later part of the burst',
      trigger: request.trigger,
      persona: request.persona,
      stage: DELIVERY_STAGE,
    }), error);
  }
  return messages;
};

const deliverAll = async (ctx, request, { parts, typing }) => {
  const [first, ...rest] = parts;
  const message = await deliverPart(ctx, request, { via: request.via, part: first });
  request.onDelivered?.();
  return [message, ...await deliverRest(ctx, request, { parts: rest, typing })];
};

export const createPartDelivery = ({ delivery, record, clock, config, logger }) => {
  const ctx = { delivery, record, clock, config, logger };
  return { deliverAll: (request, options) => deliverAll(ctx, request, options) };
};
