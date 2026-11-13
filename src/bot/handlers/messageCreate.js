import { toMessageRecord } from '../../discord/messageRecord.js';
import { createBotParentFinder } from '../botParent.js';
import { formatReceived, formatNoReply, formatNotReplyable, formatFailure, joinLines } from '../logLines.js';
import { autoReply } from './messageAutoReply.js';
import { buildChain, chainReply } from './messageChain.js';
import { isMention, mentionReply } from './messageMention.js';

const isHandled = ({ config }, message) =>
  message.channel.id === config.discord.channelId && !message.author.bot;

const handleMessage = async (deps, { message, record, parents }) => {
  const { config, ingest, messageFilter, replyPolicy, logger } = deps;
  const parent = record.reference ? await parents.find(message, record) : null;
  const { filtered } = await ingest.recordMessage(record, {
    repliesToBot: Boolean(parent), tolerateVectorErrors: true,
  });
  const lines = [formatReceived({ record, kept: filtered !== null, logging: config.logging })];
  const threaded = buildChain(deps, record, parent);
  if (threaded) return chainReply(deps, { message, threaded, lines });
  if (isMention(deps, message)) return mentionReply(deps, { message, record, lines });
  const target = messageFilter.filterAnyAuthor(record);
  if (!target) return logger.info(joinLines([...lines, formatNotReplyable()]));
  const decision = replyPolicy.decide();
  if (!decision.reply) return logger.info(joinLines([...lines, formatNoReply(decision)]));
  lines.push(await autoReply(deps, { message, target, decision }));
  return logger.info(joinLines(lines));
};

export const createMessageCreateHandler = (deps) => {
  const parents = createBotParentFinder(deps);
  return async (message) => {
    try {
      if (!isHandled(deps, message)) return;
      const record = toMessageRecord(message);
      deps.activity.noteHuman({ timestamp: message.createdTimestamp, author: record.author });
      await handleMessage(deps, { message, record, parents });
    } catch (error) {
      deps.logger.error(formatFailure({
        what: 'Error processing message',
        messageId: message.id,
        trigger: error?.trigger,
        persona: error?.persona,
        stage: error?.stage,
      }), error);
    }
  };
};
