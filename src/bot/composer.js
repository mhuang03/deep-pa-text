import { truncateForDiscord } from '../llm/sanitize.js';

export const createComposer = ({ generator, gifResolver, config }) => {
  const { maxMessageLength, truncateLookbackChars } = config.discord;

  const generate = ({ persona, target }) =>
    (target === null ? generator.generateRevive(persona) : generator.generateReply(persona, target));

  // The single place that runs generate -> resolve GIFs -> shorten to the limit. A null target is a revive.
  const compose = async ({ persona, target }) => {
    const response = await generate({ persona, target });
    const resolved = await gifResolver.resolve(response);
    const content = truncateForDiscord(resolved.content, {
      maxLength: maxMessageLength,
      lookback: truncateLookbackChars,
    });
    return { response, content, gifLinks: resolved.gifLinks };
  };

  return { compose };
};
