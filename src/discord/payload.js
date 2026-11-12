import { EmbedBuilder } from 'discord.js';

export const buildPayload = ({ content, gifLinks, authorEmbed }) => {
  const gifEmbeds = gifLinks
    .filter(({ url }) => url)
    .map(({ url }) => new EmbedBuilder().setImage(url));
  return { content, embeds: [...gifEmbeds, authorEmbed] };
};
