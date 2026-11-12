import { SYSTEM_PROMPT, buildReplyPrompt, buildRevivePrompt } from './prompts.js';

export const createGenerator = ({ chatClient, retriever, userDirectory }) => {
  const generateReply = async (persona, record) => {
    const buckets = await retriever.retrieveForReply(persona, record);
    const user = buildReplyPrompt({
      author: persona,
      name: userDirectory.nameOf(persona),
      message: record.content,
      buckets,
    });
    return chatClient.complete({ system: SYSTEM_PROMPT, user });
  };

  const generateRevive = async (persona) => {
    const examples = await retriever.retrieveForRevive(persona);
    const user = buildRevivePrompt({
      author: persona,
      name: userDirectory.nameOf(persona),
      examples,
    });
    return chatClient.complete({ system: SYSTEM_PROMPT, user });
  };

  return { generateReply, generateRevive };
};
