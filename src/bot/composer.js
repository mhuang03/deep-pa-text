import { truncateForDiscord } from '../text/truncate.js';

export const createComposer = ({ generator, gifResolver, config }) => {
  const { maxMessageLength, truncateLookbackChars } = config.discord;

  const generate = ({ persona, target, context }) =>
    (target === null
      ? generator.generateRevive(persona, context)
      : generator.generateReply(persona, target, context));

  const composePart = async (text) => {
    const resolved = await gifResolver.resolve(text);
    const content = truncateForDiscord(resolved.content, {
      maxLength: maxMessageLength,
      lookback: truncateLookbackChars,
    });
    return { text, content, gifLinks: resolved.gifLinks };
  };

  // The single place that runs generate -> resolve GIFs -> shorten to the limit, once per part.
  // A null target is a revive.
  const compose = async ({ persona, target, context }) => {
    const { response, parts: texts } = await generate({ persona, target, context });
    const parts = [];
    for (const text of texts) parts.push(await composePart(text));
    return { response, parts };
  };

  return { compose };
};
