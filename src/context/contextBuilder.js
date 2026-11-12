import { buildTranscript } from '../text/transcript.js';

export const createContextBuilder = ({ channelHistory, botMessageResolver, messageFilter, config }) => {
  const { transcriptLimit, maxEntryChars, maxAgeMs } = config.context;

  const reviveLimit = config.revive.transcriptLimit;

  const forRevive = async ({ channel, nowMs }) => {
    const messages = await channelHistory.fetchBefore(channel, { limit: reviveLimit });
    const transcript = buildTranscript(messages, {
      resolveBot: botMessageResolver.resolve,
      transform: messageFilter.transform,
      maxEntryChars,
      notBefore: -Infinity,
    });
    const newest = messages.at(-1);
    return { transcript, quietMs: newest ? nowMs - newest.createdTimestamp : null, nowMs };
  };

  const forReply = async ({ channel, target }) => {
    if (!channel) return { transcript: [] };
    const messages = await channelHistory.fetchBefore(channel, {
      before: target.id, limit: transcriptLimit,
    });
    const transcript = buildTranscript(messages, {
      resolveBot: botMessageResolver.resolve,
      transform: messageFilter.transform,
      maxEntryChars,
      notBefore: target.timestamp - maxAgeMs,
    });
    return { transcript };
  };

  return { forReply, forRevive };
};
