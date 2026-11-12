import { sanitizeResponse } from './sanitize.js';
import { buildQueryText } from '../retrieval/queryText.js';
import { SYSTEM_PROMPT, buildReplyPrompt, buildRevivePrompt } from './prompts.js';

const EMPTY_RESPONSE_MESSAGE = 'LLM returned an empty response';

export const createGenerator = ({ chatClient, retriever, userDirectory, config }) => {
  const complete = async (user) => {
    const response = sanitizeResponse(await chatClient.complete({ system: SYSTEM_PROMPT, user }));
    if (response === '') throw new Error(EMPTY_RESPONSE_MESSAGE);
    return response;
  };

  const generateReply = async (persona, record, context = {}) => {
    const transcript = context.transcript ?? [];
    const queryText = buildQueryText(record, transcript, config.retrieval);
    const buckets = await retriever.retrieveForReply(persona, record, { queryText });
    const user = buildReplyPrompt({
      author: persona,
      name: userDirectory.nameOf(persona),
      message: record.content,
      messageAuthor: record.author,
      buckets,
      transcript,
      timeZone: config.context.timeZone,
    });
    return complete(user);
  };

  const generateRevive = async (persona) => {
    const examples = await retriever.retrieveForRevive(persona);
    const user = buildRevivePrompt({
      author: persona,
      name: userDirectory.nameOf(persona),
      examples,
    });
    return complete(user);
  };

  return { generateReply, generateRevive };
};
