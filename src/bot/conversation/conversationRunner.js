import { TRIGGERS } from '../../util/triggers.js';
import { randomInt } from '../../util/random.js';
import { formatFailure } from '../logLines.js';

const abortedError = () => Object.assign(new Error('Conversation abandoned: shutting down'), { isConversationAborted: true });

// What a delivered turn is to the rest of the conversation: its first message and all its text.
const toTurn = ({ delivered }, { persona, clock }) => {
  if (delivered.length === 0) throw new Error(`The turn by ${persona} delivered no message`);
  const [first] = delivered;
  return {
    id: first.message.id,
    speaker: persona,
    content: delivered.map(({ text }) => text).join('\n'),
    timestamp: first.message.createdTimestamp ?? clock.now(),
  };
};

const toTarget = (turn) => turn && {
  id: turn.id, author: turn.speaker, content: turn.content, timestamp: turn.timestamp,
};

// Waits out what is left of the gap before this turn; a shutdown during the wait ends the conversation.
const spacing = ({ clock, lifecycle, settings, random }) => {
  const delay = randomInt(random, settings.minDelayMs, settings.maxDelayMs);
  const drawnAt = clock.now();
  return async () => {
    const remaining = Math.max(0, delay - (clock.now() - drawnAt));
    if (remaining > 0) await clock.sleep(remaining);
    if (lifecycle.isShuttingDown()) throw abortedError();
  };
};

const buildRequest = (ctx, state) => {
  const { plan, channel, guild, said, previous, index, beforeDeliver } = state;
  const last = plan.turns.length - 1;
  return {
    trigger: TRIGGERS.CONVERSATION,
    persona: plan.turns[index],
    target: toTarget(previous),
    conversation: {
      id: plan.id,
      topic: plan.topic,
      premise: plan.premise,
      participants: plan.personas,
      turns: said.map(({ speaker, content, timestamp }) => ({ speaker, content, timestamp })),
      turnIndex: index,
      remaining: last - index,
      isLast: index === last,
      situation: plan.situation,
    },
    guild,
    channel,
    via: { type: 'channel', channel },
    beforeDeliver,
    onDelivered: ctx.onDelivered,
  };
};

const playTurn = async (ctx, state) => {
  const { responder, clock } = ctx;
  const beforeDeliver = state.index > 0 ? spacing(ctx) : undefined;
  const request = buildRequest(ctx, { ...state, beforeDeliver });
  const result = await responder.respond(request);
  return toTurn(result, { persona: request.persona, clock });
};

const logStopped = (ctx, { plan, index, error }) => ctx.logger.error(formatFailure({
  what: `Conversation ${plan.id} ended after ${index} of ${plan.turns.length} turns`,
  trigger: TRIGGERS.CONVERSATION,
  persona: plan.turns[index],
  stage: error?.stage,
}), error);

// Plays the planned turns in order. The first turn failing rejects (nothing was sent); a later failure
// ends the conversation there. Humans are never consulted: the script goes on as planned.
const run = async (ctx, { plan, channel, guild, onFirstDelivered }) => {
  const { lifecycle } = ctx;
  const said = [];
  const onDelivered = () => {
    if (said.length === 0) onFirstDelivered?.();
    ctx.activity.noteBot();
    ctx.replyPolicy.noteReply({ resetMisses: false });
  };
  for (let index = 0; index < plan.turns.length; index += 1) {
    if (lifecycle.isShuttingDown()) break;
    try {
      const previous = said.at(-1) ?? null;
      said.push(await playTurn({ ...ctx, onDelivered }, { plan, channel, guild, said, previous, index }));
    } catch (error) {
      if (error?.isConversationAborted) break;
      if (index === 0) throw error;
      logStopped(ctx, { plan, index, error });
      break;
    }
  }
  return { delivered: said.length };
};

export const createConversationRunner = ({
  responder, replyPolicy, activity, lifecycle, random, clock, config, logger,
}) => {
  const ctx = {
    responder, replyPolicy, activity, lifecycle, random, clock, logger, settings: config.conversation,
  };
  return { run: (options) => run(ctx, options) };
};
