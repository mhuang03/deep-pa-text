import { buildTranscript } from './transcript.js';

export const createContextBuilder = ({ channelHistory, botMessageResolver, messageFilter, config }) => {
  const { transcriptLimit, maxEntryChars, maxAgeMs } = config.context;

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

  return { forReply };
};
