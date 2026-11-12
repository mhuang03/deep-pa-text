import { EmbedBuilder } from 'discord.js';

export const THINKING_TEXT = 'thinking...';

export const createAuthorEmbeds = ({ config, logger }) => {
  const findAvatarUrl = async (author, guild) => {
    try {
      const members = await guild.members.fetch({ query: author, limit: 1 });
      return members.first()?.displayAvatarURL() ?? null;
    } catch (error) {
      logger.warn(`Could not fetch avatar for ${author}:`, error);
      return null;
    }
  };

  const make = async (author, guild, { thinking = false } = {}) => {
    const iconURL = await findAvatarUrl(author, guild);
    const embed = new EmbedBuilder()
      .setAuthor({ name: author, iconURL })
      .setColor(config.discord.embedColor);
    if (thinking) embed.setFooter({ text: THINKING_TEXT });
    return embed;
  };

  return { make };
};
