import { parseJsonObject } from '../../text/jsonObject.js';
import { CONVERSATION_TOPIC_SYSTEM_PROMPT, buildTopicPrompt } from './conversationPrompts.js';

const WHITESPACE = /\s+/g;

const isText = (value) => typeof value === 'string' && value.trim() !== '';

const tidy = (text, max) => text.replace(WHITESPACE, ' ').trim().slice(0, max).trimEnd();

// An answer is valid when `choice` names a candidate and both texts are present; null otherwise.
const interpret = (answer, { count, settings }) => {
  const parsed = parseJsonObject(answer);
  if (!parsed) return null;
  const { choice, topic, premise } = parsed;
  if (!Number.isInteger(choice) || choice < 1 || choice > count) return null;
  if (!isText(topic) || !isText(premise)) return null;
  return {
    choice: choice - 1,
    topic: tidy(topic, settings.maxTopicChars),
    premise: tidy(premise, settings.maxPremiseChars),
  };
};

// Asks the model to pick and sharpen a topic. An invalid answer is asked for again up to planRetries
// times; a thrown error is not retried (the chat client has already retried). Returns null when it fails.
export const createTopicCall = ({ chatClient, config, logger }) => {
  const settings = config.conversation;

  const choose = async (input) => {
    const user = buildTopicPrompt({ ...input, timeZone: config.context.timeZone });
    for (let attempt = 0; attempt <= settings.planRetries; attempt += 1) {
      let answer;
      try {
        answer = await chatClient.complete({ system: CONVERSATION_TOPIC_SYSTEM_PROMPT, user });
      } catch (error) {
        logger.warn('The conversation topic call failed:', error);
        return null;
      }
      const chosen = interpret(answer, { count: input.candidates.length, settings });
      if (chosen) return chosen;
      logger.warn('The conversation topic answer was not usable; ignoring it.');
    }
    return null;
  };

  return { choose };
};
