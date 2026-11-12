import { EmbedBuilder } from 'discord.js';

const DEFAULT_MAX_EMBEDS = 10;

// The bot never pings anyone: nothing in generated text may resolve to a mention.
export const SAFE_MENTIONS = Object.freeze({ parse: Object.freeze([]) });

// Discord rejects a message with more embeds than its limit; the author embed keeps its slot.
export const buildPayload = ({ content, gifLinks, authorEmbed, maxEmbeds = DEFAULT_MAX_EMBEDS }) => {
  const gifSlots = Math.max(0, maxEmbeds - (authorEmbed ? 1 : 0));
  const gifEmbeds = gifLinks
    .filter(({ url }) => url)
    .slice(0, gifSlots)
    .map(({ url }) => new EmbedBuilder().setImage(url));
  return { content, embeds: authorEmbed ? [...gifEmbeds, authorEmbed] : gifEmbeds };
};

export const withSafeMentions = (payload, { repliedUser } = {}) => {
  const allowedMentions = { parse: [] };
  if (repliedUser !== undefined) allowedMentions.repliedUser = repliedUser;
  return { ...payload, allowedMentions };
};
