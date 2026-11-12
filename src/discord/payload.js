import { EmbedBuilder } from 'discord.js';

// The bot never pings anyone: nothing in generated text may resolve to a mention.
export const SAFE_MENTIONS = Object.freeze({ parse: Object.freeze([]) });

export const buildPayload = ({ content, gifLinks, authorEmbed }) => {
  const gifEmbeds = gifLinks
    .filter(({ url }) => url)
    .map(({ url }) => new EmbedBuilder().setImage(url));
  return { content, embeds: [...gifEmbeds, authorEmbed] };
};

export const withSafeMentions = (payload, { repliedUser } = {}) => {
  const allowedMentions = { parse: [] };
  if (repliedUser !== undefined) allowedMentions.repliedUser = repliedUser;
  return { ...payload, allowedMentions };
};
