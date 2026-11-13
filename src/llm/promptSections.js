import { formatTranscript, truncateEntry } from '../text/transcript.js';
import { describeLocalTime, describeQuiet } from '../text/situation.js';

const EXAMPLES_INTRO = {
  replies: 'Here are examples of how the user replied to messages similar to the one they just received. "them" is the message the user was responding to and "you" is the user\'s reply:',
  similar: 'Here are some examples of some messages that the user has sent that are similar in semantic meaning to the message they just received:',
  gifs: "Here are some examples of responses to similar messages where the user's response included a GIF:",
  other: "Here are some examples of other messages that the user has sent that are not necessarily similar in semantic meaning to the message they just received, but are still representative of the user's general style and tone:",
  past: 'Here are some examples of messages that the user has sent in the past:',
};

const FREQUENT_INTRO = 'The user sends some of these messages often. Number of times they have sent each (use them only where they fit):';
const AVOID_INTRO = 'The bot you are part of recently sent these messages in the channel. Do not repeat them or reuse their distinctive phrasing:';

const BURST_TEMPLATE = 'This user often sends several short messages in a row instead of one longer message. If that fits here, you may split your response into up to <maxMessages> separate messages by putting <split> on its own line between them. Only split where this user would.';

const THREAD_INTRO = 'You are in a reply thread. Your own earlier messages in it appear as assistant turns; other people\'s messages are prefixed with their username. Write your next message in the thread.';
const LAST_CONVERSATION_INTRO = 'Here is the end of the last conversation in the channel, oldest first:';
const TOPIC_EXAMPLES_INTRO = 'Here are messages this user has sent about similar things:';
const ONLY_THESE = 'Only these people take part; do not address anyone else.';
const OPENER_TASK = 'You are starting it. Write the message that opens the conversation. Do not greet the channel.';
const TURN_TASK = 'Write your next message. React to what was just said, stay with the topic unless the conversation has naturally moved on, and do not end every message with a question.';
const LAST_TURN = 'Nobody replies after this message, so do not ask the others a question.';
const STARTERS_INTRO = 'Here are messages this user has sent to start a conversation after the channel had been quiet:';

export const identity = ({ author, name }) =>
  `The user you are emulating has username "${author}", and their real name is "${name}".`;

export const transcript = ({ transcript: entries, timeZone }) => {
  if (!entries || entries.length === 0) return null;
  return `Here is the recent conversation in the channel, oldest first, for context:\n${formatTranscript(entries, { timeZone })}`;
};

export const target = ({ message, messageAuthor }) =>
  `The user has just received this message from "${messageAuthor}": "${message}".`;

const examples = (intro, list) => `${intro}\n${JSON.stringify(list)}`;

// "them" comes first so the model reads the prompt before the answer.
const serializeExample = ({ you, them }, maxEntryChars) =>
  (them === null || them === undefined ? { you } : { them: truncateEntry(them, maxEntryChars), you });

export const replyExamples = ({ buckets, maxEntryChars }) =>
  examples(EXAMPLES_INTRO.replies, buckets.replies.map((e) => serializeExample(e, maxEntryChars)));
export const similarExamples = ({ buckets }) => examples(EXAMPLES_INTRO.similar, buckets.similar);
export const gifExamples = ({ buckets }) => examples(EXAMPLES_INTRO.gifs, buckets.gifs);
export const otherExamples = ({ buckets }) => examples(EXAMPLES_INTRO.other, buckets.other);
export const frequentPhrases = ({ buckets }) => {
  if (!buckets.frequent || buckets.frequent.length === 0) return null;
  return `${FREQUENT_INTRO}\n${JSON.stringify(buckets.frequent)}`;
};

export const avoidRepeats = ({ recentBotMessages }) => {
  if (!recentBotMessages || recentBotMessages.length === 0) return null;
  return `${AVOID_INTRO}\n${JSON.stringify(recentBotMessages)}`;
};

export const burst = ({ burstRate, burst: settings }) => {
  if (!settings?.enabled || !(burstRate >= settings.minRate)) return null;
  return BURST_TEMPLATE.replace('<maxMessages>', String(settings.maxMessages));
};

export const thread = () => THREAD_INTRO;

export const situation = ({ nowMs, quietMs = null, timeZone }) => {
  if (!Number.isFinite(nowMs)) return null;
  const quiet = describeQuiet(quietMs);
  const tail = quiet === null ? '' : ` The channel has been quiet for ${quiet}.`;
  return `It is ${describeLocalTime(nowMs, timeZone)}.${tail}`;
};

export const lastConversation = ({ transcript: entries, timeZone }) => {
  if (!entries || entries.length === 0) return null;
  return `${LAST_CONVERSATION_INTRO}\n${formatTranscript(entries, { timeZone })}`;
};

export const starters = ({ starters: list }) => {
  if (!list || list.length === 0) return null;
  return `${STARTERS_INTRO}\n${JSON.stringify(list)}`;
};

export const pastExamples = ({ examples: list }) => examples(EXAMPLES_INTRO.past, list);

export const topicExamples = ({ buckets }) => {
  if (buckets.similar.length === 0) return null;
  return examples(TOPIC_EXAMPLES_INTRO, buckets.similar);
};

// What the persona is doing in a scripted conversation; one paragraph, so the model reads it as one brief.
export const conversationBrief = ({ conversation, isOpener }) => {
  const { participants, topic, premise, isLast, remaining } = conversation;
  const lead = `You are taking part in a conversation in the channel between ${participants.join(', ')}. It is about: ${topic}. ${premise}`;
  if (isOpener) return [lead, ONLY_THESE, OPENER_TASK].join(' ');
  const tail = isLast ? LAST_TURN : `${remaining} more messages follow yours.`;
  return [lead, ONLY_THESE, TURN_TASK, tail].join(' ');
};

export const assemble = (sections, ctx) =>
  sections.map((section) => section(ctx)).filter((text) => text !== null).join('\n\n');
