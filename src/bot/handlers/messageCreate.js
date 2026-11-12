import { toMessageRecord } from '../../discord/messageRecord.js';
import { TRIGGERS } from '../triggers.js';
import { DELIVERY_STAGE } from '../responder.js';
import {
  formatReceived, formatNoReply, formatNotReplyable, formatReply, joinLines,
} from '../logLines.js';

export const createMessageCreateHandler = (deps) => {
  const {
    config, activity, ingest, messageFilter, replyPolicy, personaSelector, responder, logger,
  } = deps;

  const isHandled = (message) =>
    message.channel.id === config.discord.channelId && !message.author.bot;

  // A failed send arms the rate limit so a persistent failure costs one LLM call per window.
  const respond = async (message, target, persona) => {
    try {
      return await responder.respond({
        trigger: TRIGGERS.AUTO, persona, target, guild: message.guild, channel: message.channel, via: { type: 'reply', message },
      });
    } catch (error) {
      if (error?.stage === DELIVERY_STAGE) replyPolicy.noteReply({ resetMisses: false });
      throw error;
    }
  };

  const reply = async (message, target) => {
    activity.noteBot();
    const persona = await personaSelector.pickReplier(target);
    const { response } = await respond(message, target, persona);
    replyPolicy.noteReply({ resetMisses: true });
    activity.noteBot();
    return formatReply({ persona, response });
  };

  const handleMessage = async (message, record) => {
    const { filtered } = await ingest.recordMessage(record);
    const lines = [formatReceived({ record, kept: filtered !== null, logging: config.logging })];
    const target = messageFilter.filterAnyAuthor(record);
    if (!target) return logger.info(joinLines([...lines, formatNotReplyable()]));
    const decision = replyPolicy.decide();
    if (!decision.reply) return logger.info(joinLines([...lines, formatNoReply(decision)]));
    lines.push(await reply(message, target));
    return logger.info(joinLines(lines));
  };

  return async (message) => {
    try {
      if (!isHandled(message)) return;
      const record = toMessageRecord(message);
      activity.noteHuman({ timestamp: message.createdTimestamp, author: record.author });
      await handleMessage(message, record);
    } catch (error) {
      logger.error('Error processing message:', error);
    }
  };
};
