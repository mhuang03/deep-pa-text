import { toMessageRecord } from '../../discord/messageRecord.js';
import {
  formatReceived, formatNoReply, formatNotReplyable, formatReply, joinLines,
} from '../logLines.js';

export const createMessageCreateHandler = (deps) => {
  const {
    config, activity, ingest, messageFilter, replyPolicy, personaSelector, composer, logger,
  } = deps;

  const isHandled = (message) =>
    message.channel.id === config.discord.channelId && !message.author.bot;

  // Not awaited (spec 02 change 7): a failed send is logged, never unhandled.
  const sendLogged = (message, payload) =>
    Promise.resolve(message.reply(payload)).catch((error) =>
      logger.error('Error sending reply:', error));

  const reply = async (message, target) => {
    activity.noteBot();
    const persona = await personaSelector.pickReplier(target);
    const { response, payload } = await composer.composeReply({
      persona, record: target, guild: message.guild,
    });
    sendLogged(message, payload);
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
