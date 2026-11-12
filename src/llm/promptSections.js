import { formatTranscript, truncateEntry } from '../context/transcript.js';

const EXAMPLES_INTRO = {
  replies: 'Here are examples of how the user replied to messages similar to the one they just received. "them" is the message the user was responding to and "you" is the user\'s reply:',
  similar: 'Here are some examples of some messages that the user has sent that are similar in semantic meaning to the message they just received:',
  gifs: "Here are some examples of responses to similar messages where the user's response included a GIF:",
  other: "Here are some examples of other messages that the user has sent that are not necessarily similar in semantic meaning to the message they just received, but are still representative of the user's general style and tone:",
  past: 'Here are some examples of messages that the user has sent in the past:',
};

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
export const pastExamples = ({ examples: list }) => examples(EXAMPLES_INTRO.past, list);

export const assemble = (sections, ctx) =>
  sections.map((section) => section(ctx)).filter((text) => text !== null).join('\n\n');
