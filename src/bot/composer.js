import { buildPayload } from '../discord/payload.js';
import { truncateForDiscord } from '../llm/sanitize.js';

export const createComposer = ({ generator, gifResolver, authorEmbeds, config }) => {
  const { maxMessageLength, truncateLookbackChars } = config.discord;

  // The single place that runs generate -> resolve GIFs -> author embed -> payload.
  const compose = async ({ persona, guild, generate }) => {
    const response = await generate();
    const resolved = await gifResolver.resolve(response);
    const content = truncateForDiscord(resolved.content, {
      maxLength: maxMessageLength,
      lookback: truncateLookbackChars,
    });
    const authorEmbed = await authorEmbeds.make(persona, guild);
    return { response, payload: buildPayload({ content, gifLinks: resolved.gifLinks, authorEmbed }) };
  };

  const composeReply = ({ persona, record, guild }) =>
    compose({ persona, guild, generate: () => generator.generateReply(persona, record) });

  const composeRevive = ({ persona, guild }) =>
    compose({ persona, guild, generate: () => generator.generateRevive(persona) });

  return { composeReply, composeRevive };
};
