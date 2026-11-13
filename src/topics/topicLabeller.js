import { parseJsonObject } from '../text/jsonObject.js';
import { TOPIC_LABEL_SYSTEM_PROMPT } from './topicPrompts.js';

const WHITESPACE = /\s+/g;
// Whitespace is collapsed before the cut, and the cut never leaves a trailing space.
const tidy = (text, max) => text.replace(WHITESPACE, ' ').trim().slice(0, max).trimEnd();

const isText = (value) => typeof value === 'string' && value.trim() !== '';

// One answer -> { status: 'accepted', topic, summary } | { status: 'rejected' } | { status: 'failed' }.
const interpret = (answer, limits) => {
  const parsed = parseJsonObject(answer);
  if (!parsed || typeof parsed.usable !== 'boolean') return { status: 'failed', why: 'unparseable answer' };
  if (!parsed.usable) return { status: 'rejected' };
  if (!isText(parsed.topic) || !isText(parsed.summary)) return { status: 'failed', why: 'missing topic or summary' };
  return {
    status: 'accepted',
    topic: tidy(parsed.topic, limits.maxLabelChars),
    summary: tidy(parsed.summary, limits.maxSummaryChars),
  };
};

export const createTopicLabeller = ({ chatClient, logger, config }) => {
  const label = async (representatives) => {
    const user = JSON.stringify(representatives.map(({ author, content }) => ({ author, text: content })));
    try {
      const answer = await chatClient.complete({ system: TOPIC_LABEL_SYSTEM_PROMPT, user });
      const result = interpret(answer, config.topics);
      if (result.status !== 'failed') return result;
      logger.warn(`Topic label ignored: ${result.why}`);
      return { status: 'failed' };
    } catch (error) {
      logger.warn('Topic labelling call failed:', error);
      return { status: 'failed' };
    }
  };
  return { label };
};
