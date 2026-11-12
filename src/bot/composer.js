import { buildPayload } from '../discord/payload.js';

export const createComposer = ({ generator, gifResolver, authorEmbeds }) => {
  // The single place that runs generate -> resolve GIFs -> author embed -> payload.
  const compose = async ({ persona, guild, generate }) => {
    const response = await generate();
    const { content, gifLinks } = await gifResolver.resolve(response);
    const authorEmbed = await authorEmbeds.make(persona, guild);
    return { response, payload: buildPayload({ content, gifLinks, authorEmbed }) };
  };

  const composeReply = ({ persona, record, guild }) =>
    compose({ persona, guild, generate: () => generator.generateReply(persona, record) });

  const composeRevive = ({ persona, guild }) =>
    compose({ persona, guild, generate: () => generator.generateRevive(persona) });

  return { composeReply, composeRevive };
};
