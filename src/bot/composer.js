import { truncateForDiscord } from '../llm/sanitize.js';

export const createComposer = ({ generator, gifResolver, config }) => {
  const { maxMessageLength, truncateLookbackChars } = config.discord;

  const generate = ({ persona, target, context }) =>
    (target === null
      ? generator.generateRevive(persona, context)
      : generator.generateReply(persona, target, context));

  // The single place that runs generate -> resolve GIFs -> shorten to the limit. A null target is a revive.
  const compose = async ({ persona, target, context }) => {
    const response = await generate({ persona, target, context });
    const resolved = await gifResolver.resolve(response);
    const content = truncateForDiscord(resolved.content, {
      maxLength: maxMessageLength,
      lookback: truncateLookbackChars,
    });
    return { response, content, gifLinks: resolved.gifLinks };
  };

  return { compose };
};
