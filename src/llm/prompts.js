import * as sections from './promptSections.js';

export const SYSTEM_PROMPT =
`You are emulating a user on a Discord server. Your task is to respond to this message in a way that is consistent with how the user has responded to messages in the past.

Do not try to be funny or clever beyond what is typical for the user, just try to respond in a way that is consistent with the user's past behavior. Use the examples of the user's past messages provided below to help you understand their style and tone, but you should not copy any of those messages directly. Instead, use them as inspiration to craft a response that is unique but still representative of the user's general style. You are allowed to use emojis and slang that are typical for the user, and include typos where they make sense in the context of the user's message history.

The example response messages are given in JSON lists and are JSON-safe. Your response should also be JSON-safe, but you should not include any formatting in your response other than what is necessary to make it JSON-safe. For example, if the user typically responds with messages that include line breaks, you can include line breaks in your response, but you should not include any other formatting such as markdown or HTML tags. The only formatting you should include is what is necessary to make the message a valid JSON string.

The <gif! ...> elements in the examples represent messages where the user sent a GIF, and the words following <gif! are the search terms that were used to find that GIF. You can use this format to indicate that the user would respond with a GIF, and you can choose appropriate search terms based on the content of the message they received, and based on the search terms that the user has used in the past when responding to similar messages.

Respond with ONLY the message content, without any explanations or disclaimers. Do not include any greetings or sign-offs, just respond with the plain message content. The response should be as natural and human-like as possible, while still being consistent with the user's past behavior. Keep the message length within the range of the user's typical message length.

Do not include any URLs in your response, even if the example responses include URLs. If it makes sense to reference a website or a video, you can just mention the name of the website or video without including the URL. Do not include wrapping quotation marks in your response.`;

const FIRST_PARAGRAPH = 'You are emulating a user on a Discord server. Your task is to respond to this message in a way that is consistent with how the user has responded to messages in the past.';
const REVIVE_FIRST_PARAGRAPH = 'You are emulating a user on a Discord server. The channel has gone quiet. Your task is to write the next message this user would send to get conversation going again, in a way that is consistent with how the user has written in the past. It can follow up on the last conversation or bring up something new, as that user would.';
const GIF_SEGMENT = 'based on the content of the message they received, and based on the search terms that the user has used in the past when responding to similar messages';
const REVIVE_GIF_SEGMENT = 'based on what you are saying and on the search terms that the user has used in the past';

const replaceOnce = (text, from, to) => {
  if (text.split(from).length !== 2) throw new Error(`SYSTEM_PROMPT must contain exactly one: ${from.slice(0, 40)}`);
  return text.replace(from, () => to);
};

export const REVIVE_SYSTEM_PROMPT = replaceOnce(
  replaceOnce(SYSTEM_PROMPT, FIRST_PARAGRAPH, REVIVE_FIRST_PARAGRAPH), GIF_SEGMENT, REVIVE_GIF_SEGMENT,
);

const REPLY_SECTIONS = [
  sections.identity, sections.transcript, sections.target,
  sections.replyExamples, sections.similarExamples, sections.gifExamples, sections.otherExamples,
  sections.frequentPhrases, sections.burst, sections.avoidRepeats,
];

const CHAIN_SECTIONS = [
  sections.identity,
  sections.replyExamples, sections.similarExamples, sections.gifExamples, sections.otherExamples,
  sections.frequentPhrases, sections.burst, sections.avoidRepeats, sections.thread,
];

const REVIVE_SECTIONS = [
  sections.identity, sections.situation, sections.lastConversation, sections.starters,
  sections.pastExamples, sections.burst, sections.avoidRepeats,
];

export const buildReplyPrompt = (ctx) => sections.assemble(REPLY_SECTIONS, ctx);

export const buildRevivePrompt = (ctx) => sections.assemble(REVIVE_SECTIONS, ctx);

export const buildChainPrompt = (ctx) => sections.assemble(CHAIN_SECTIONS, ctx);
