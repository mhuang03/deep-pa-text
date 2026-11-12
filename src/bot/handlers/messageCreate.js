import { toMessageRecord } from '../../discord/messageRecord.js';
import { TRIGGERS } from '../triggers.js';
import { DELIVERY_STAGE } from '../responder.js';
import { createBotParentFinder } from '../botParent.js';
import {
  formatReceived, formatNoReply, formatNotReplyable, formatReply, formatChainDecision, formatFailure, joinLines,
} from '../logLines.js';

export const createMessageCreateHandler = (deps) => {
  const {
    config, activity, ingest, messageFilter, replyPolicy, personaSelector, responder, logger,
    chainBuilder, chainPolicy,
  } = deps;
  const parents = createBotParentFinder(deps);

  const isHandled = (message) =>
    message.channel.id === config.discord.channelId && !message.author.bot;

  // A failed send arms the rate limit so a persistent failure costs one LLM call per window.
  const respond = async (message, request) => {
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
  const reply = async (message, target) => {
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
      const { response } = await respond(message, { trigger: TRIGGERS.AUTO, persona, target, onDelivered });
      return formatReply({ persona, response });
    } catch (error) {
      if (!delivered) undo();
      if (error?.stage !== DELIVERY_STAGE) replyPolicy.noteFailure();
      throw error;
    }
  };

  // The slot is claimed by decide() and held until the whole attempt, burst included, is over.
  const autoReply = async (message, target, decision) => {
    try {
      return await reply(message, target);
    } finally {
      decision.release();
    }
  };

  // Replies in a thread with a bot message continue it as the same persona; they never reach the random policy.
  const chainReply = async (message, chain, target, lines) => {
    const { persona, botTurns } = chain;
    const userId = message.author.id;
    const decision = chainPolicy.decide({ ...chain, userId });
    const summary = formatChainDecision({ persona, botTurns, decision });
    if (!decision.reply) return logger.info(joinLines([...lines, summary]));
    chainPolicy.begin({ userId });
    try {
      const onDelivered = () => replyPolicy.noteReply({ resetMisses: false });
      const { response } = await respond(message, {
        trigger: TRIGGERS.CHAIN, persona, target, chain, onDelivered,
      });
      return logger.info(joinLines([...lines, summary, formatReply({ persona, response })]));
    } finally {
      chainPolicy.end();
    }
  };

  // With chains off, a reply to a bot message is an ordinary message.
  const buildChain = (record, parent) => {
    if (!config.chain.enabled) return null;
    const target = parent && messageFilter.filterForChain(record);
    const chain = target && chainBuilder.build(target, parent);
    return chain ? { chain, target } : null;
  };

  const handleMessage = async (message, record) => {
    const parent = record.reference ? await parents.find(message, record) : null;
    const { filtered } = await ingest.recordMessage(record, {
      repliesToBot: Boolean(parent), tolerateVectorErrors: true,
    });
    const lines = [formatReceived({ record, kept: filtered !== null, logging: config.logging })];
    const threaded = buildChain(record, parent);
    if (threaded) return chainReply(message, threaded.chain, threaded.target, lines);
    const target = messageFilter.filterAnyAuthor(record);
    if (!target) return logger.info(joinLines([...lines, formatNotReplyable()]));
    const decision = replyPolicy.decide();
    if (!decision.reply) return logger.info(joinLines([...lines, formatNoReply(decision)]));
    lines.push(await autoReply(message, target, decision));
    return logger.info(joinLines(lines));
  };

  return async (message) => {
    try {
      if (!isHandled(message)) return;
      const record = toMessageRecord(message);
      activity.noteHuman({ timestamp: message.createdTimestamp, author: record.author });
      await handleMessage(message, record);
    } catch (error) {
      logger.error(formatFailure({
        what: 'Error processing message',
        messageId: message.id,
        trigger: error?.trigger,
        persona: error?.persona,
        stage: error?.stage,
      }), error);
    }
  };
};
