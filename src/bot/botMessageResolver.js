import { readPersonaFromEmbeds } from '../discord/botPersona.js';

export const createBotMessageResolver = ({ botMessageStore, userDirectory, getBotUserId }) => {
  const fromStore = (discordMessage) => {
    const stored = botMessageStore.getById(discordMessage.id);
    return stored && { persona: stored.persona, content: stored.content };
  };

  // Messages sent before the store existed only carry the persona in their embed.
  const fromEmbeds = (discordMessage) => {
    const botUserId = getBotUserId();
    if (!botUserId || discordMessage.author?.id !== botUserId) return null;
    const persona = readPersonaFromEmbeds(discordMessage, userDirectory);
    return persona && { persona, content: discordMessage.content };
  };

  const resolve = (discordMessage) => fromStore(discordMessage) ?? fromEmbeds(discordMessage);

  return { resolve };
};
