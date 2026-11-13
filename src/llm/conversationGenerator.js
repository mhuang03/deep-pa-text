import { buildQueryText } from '../text/queryText.js';
import { normalizeForDedup } from '../text/normalize.js';
import { truncateEntry } from '../text/transcript.js';
import {
  SYSTEM_PROMPT, CONVERSATION_OPENER_SYSTEM_PROMPT, buildConversationPrompt,
} from './prompts.js';

const NEWLINES = /\r?\n/g;

const sharedInputs = ({ userDirectory, inputs, config }, persona) => ({
  author: persona,
  name: userDirectory.nameOf(persona),
  recentBotMessages: inputs.recentBotMessages(),
  burstRate: inputs.burstRate(persona),
  burst: config.burst,
  maxEntryChars: config.context.maxEntryChars,
  timeZone: config.context.timeZone,
});

// The opener has nothing to answer, so its retrieval query is the topic itself.
const generateOpener = async (deps, persona, conversation) => {
  const { complete, retriever, inputs } = deps;
  const { nowMs, quietMs = null } = conversation.situation;
  const content = `${conversation.topic}. ${conversation.premise}`;
  const record = { id: conversation.id, author: '', content, timestamp: nowMs };
  const buckets = await retriever.retrieveForReply(persona, record, { queryText: content });
  const starters = inputs.starters(persona);
  const shown = new Set([...starters, ...buckets.similar].map(normalizeForDedup));
  const examples = (await retriever.retrieveForRevive(persona))
    .filter((text) => !shown.has(normalizeForDedup(text)));
  const user = buildConversationPrompt({
    ...sharedInputs(deps, persona), isOpener: true, conversation, nowMs, quietMs, starters, buckets, examples,
  });
  return complete(user, CONVERSATION_OPENER_SYSTEM_PROMPT);
};

const toEntry = ({ speaker, content, timestamp }, maxEntryChars) => ({
  speaker, content: truncateEntry(content.replace(NEWLINES, ' ').trim(), maxEntryChars), timestamp,
});

// `turns` already ends with the target, so the transcript is everything before it.
const generateLater = async (deps, persona, { target, conversation }) => {
  const { complete, retriever, config } = deps;
  const earlier = conversation.turns.slice(0, -1);
  const queryText = buildQueryText(target, earlier, config.retrieval);
  const buckets = await retriever.retrieveForReply(persona, target, { queryText });
  const shared = sharedInputs(deps, persona);
  const user = buildConversationPrompt({
    ...shared,
    isOpener: false,
    conversation,
    message: target.content,
    messageAuthor: target.author,
    transcript: earlier.map((turn) => toEntry(turn, shared.maxEntryChars)),
    buckets,
  });
  return complete(user, SYSTEM_PROMPT);
};

export const createConversationGenerator = (deps) => ({
  generateConversationTurn: (persona, target, conversation) => (target === null
    ? generateOpener(deps, persona, conversation)
    : generateLater(deps, persona, { target, conversation })),
});
