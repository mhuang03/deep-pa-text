const ELLIPSIS = '…';

const clean = (text) => text.replace(/\r?\n/g, ' ').trim();

export const truncateEntry = (text, maxEntryChars) =>
  (text.length > maxEntryChars ? `${text.slice(0, maxEntryChars)}${ELLIPSIS}` : text);

// Bot messages we cannot attribute to a persona, and other bots, carry no usable speaker.
const speakerAndContent = (message, { resolveBot, transform }) => {
  const bot = resolveBot(message);
  if (bot) return { speaker: bot.persona, content: transform(bot.content) };
  if (message.author?.bot) return null;
  return { speaker: message.author.username, content: transform(message.content) };
};

const toEntry = (message, options) => {
  const resolved = speakerAndContent(message, options);
  if (!resolved) return null;
  const content = truncateEntry(clean(resolved.content ?? ''), options.maxEntryChars);
  if (content === '') return null;
  if (message.createdTimestamp < options.notBefore) return null;
  return {
    id: message.id,
    speaker: resolved.speaker,
    content,
    timestamp: message.createdTimestamp,
    replyTo: message.reference?.messageId ?? null,
  };
};

export const buildTranscript = (messages, options) => {
  const speakers = new Map();
  const entries = [];
  messages.forEach((message) => {
    const entry = toEntry(message, options);
    if (!entry) return;
    const replyTo = speakers.get(entry.replyTo) ?? null;
    speakers.set(entry.id, entry.speaker);
    entries.push({ ...entry, replyTo });
  });
  return entries;
};

export const formatTranscript = (entries, { timeZone }) => {
  const clock = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
  });
  return entries.map((entry) => {
    const reply = entry.replyTo ? ` (replying to ${entry.replyTo})` : '';
    return `[${clock.format(entry.timestamp)}] ${entry.speaker}${reply}: ${entry.content}`;
  }).join('\n');
};
