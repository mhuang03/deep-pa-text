import { collapseStretched } from './normalize.js';

const GIF_TOKEN = /<gif![^>]*>/gi;
const EMOJI_NAME = /:[\w+-]+:/g;
const MENTION = /@[\p{L}\p{N}_.]+/gu;
const NOT_TEXT = /[^\p{L}\p{N}'\s]/gu;
const WHITESPACE = /\s+/g;
const PREFIX_WORDS = 3;

// The words a person actually wrote: GIFs, emoji names, mentions and punctuation carry no subject.
export const topicText = (content) => String(content)
  .replace(GIF_TOKEN, ' ')
  .replace(EMOJI_NAME, ' ')
  .replace(MENTION, ' ')
  .replace(NOT_TEXT, '')
  .replace(WHITESPACE, ' ')
  .trim();

// Lower case with stretched letters collapsed, so "YEAHHH yeah yeah" counts as one repeated word.
export const normalisedTopicText = (content) => collapseStretched(topicText(content).toLowerCase());

export const topicWords = (content) => {
  const text = normalisedTopicText(content);
  return text === '' ? [] : text.split(' ');
};

// The first words of a message, to spot templates and catchphrases.
export const topicPrefix = (content) => topicWords(content).slice(0, PREFIX_WORDS).join(' ');

export const isTopicEligible = (content, { minWords, minDistinctWords, minChars }) => {
  const words = topicWords(content);
  if (words.length < minWords) return false;
  if (new Set(words).size < minDistinctWords) return false;
  return words.join(' ').length >= minChars;
};
