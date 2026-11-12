import { buildQueryText } from '../text/queryText.js';
import { SYSTEM_PROMPT, buildReplyPrompt, buildChainPrompt } from './prompts.js';

// The thread is the conversation: earlier turns go to the model as chat turns, not as prompt text.
const generateChainReply = async (deps, { persona, record, chain }) => {
  const { complete, retriever, userDirectory, inputs, config } = deps;
  const queryText = buildQueryText(record, chain.turns.slice(0, -1), config.retrieval);
  const buckets = await retriever.retrieveForReply(persona, record, { queryText });
  const user = buildChainPrompt({
    author: persona,
    name: userDirectory.nameOf(persona),
    buckets,
    recentBotMessages: inputs.recentBotMessages(),
    burstRate: inputs.burstRate(persona),
    burst: config.burst,
    maxEntryChars: config.context.maxEntryChars,
  });
  return complete(user, SYSTEM_PROMPT, chain.turns);
};

const generateTranscriptReply = async (deps, { persona, record, transcript }) => {
  const { complete, retriever, userDirectory, inputs, config } = deps;
  const queryText = buildQueryText(record, transcript, config.retrieval);
  const buckets = await retriever.retrieveForReply(persona, record, { queryText });
  const user = buildReplyPrompt({
    author: persona,
    name: userDirectory.nameOf(persona),
    message: record.content,
    messageAuthor: record.author,
    buckets,
    transcript,
    recentBotMessages: inputs.recentBotMessages(),
    burstRate: inputs.burstRate(persona),
    burst: config.burst,
    timeZone: config.context.timeZone,
    maxEntryChars: config.context.maxEntryChars,
  });
  return complete(user);
};

export const createReplyGenerator = (deps) => ({
  generateReply: (persona, record, context = {}) => (context.chain
    ? generateChainReply(deps, { persona, record, chain: context.chain })
    : generateTranscriptReply(deps, { persona, record, transcript: context.transcript ?? [] })),
});
