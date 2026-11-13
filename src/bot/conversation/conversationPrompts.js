import * as sections from '../../llm/promptSections.js';

export const CONVERSATION_TOPIC_SYSTEM_PROMPT =
`You are planning a short group chat between members of a private Discord server. It will be written afterwards in their own voices. Choose what they would most plausibly talk about right now.

Reply with a single JSON object and nothing else:
{"choice": <number of the candidate you chose>, "topic": "<at most 8 words>", "premise": "<one or two sentences: what prompts the conversation and the angle it takes>"}

Prefer a candidate that fits the time and what was said recently, without repeating a recently used topic. You may sharpen a candidate into something more specific, but stay within what its sample messages show these people actually talk about.`;

const RECENT_INTRO = 'These topics were used recently. Do not choose them again:';
const CANDIDATES_INTRO = 'Candidate topics:';
const OPENERS_INTRO = 'Messages that have restarted this chat after a quiet spell:';
const UNNAMED = '(unnamed)';

const recentSection = (recent) => (recent.length === 0 ? null : `${RECENT_INTRO}\n${JSON.stringify(recent)}`);

const describeCandidate = (candidate, number) => {
  const name = candidate.label === null ? UNNAMED : `${candidate.label}: ${candidate.summary}`;
  return `${number}. ${name}\nSample messages: ${JSON.stringify(candidate.samples)}`;
};

const candidatesSection = (candidates) =>
  [CANDIDATES_INTRO, ...candidates.map((candidate, index) => describeCandidate(candidate, index + 1))].join('\n');

const openersSection = (openers) => (openers.length === 0 ? null : `${OPENERS_INTRO}\n${JSON.stringify(openers)}`);

// Sections that have nothing to say are left out; the time and the candidates are always there.
export const buildTopicPrompt = ({ now, context, recent, candidates, openers, timeZone }) => [
  sections.situation({ nowMs: now, quietMs: context.quietMs ?? null, timeZone }),
  sections.lastConversation({ transcript: context.transcript, timeZone }),
  recentSection(recent),
  candidatesSection(candidates),
  openersSection(openers),
].filter((text) => text !== null).join('\n\n');
