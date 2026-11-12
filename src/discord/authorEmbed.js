import { EmbedBuilder } from 'discord.js';

const THINKING_TEXT = 'thinking...';

export const createAuthorEmbeds = ({ config, memberProfiles }) => {
  const make = async (author, guild, { thinking = false } = {}) => {
    const { avatarURL } = await memberProfiles.current(author, guild);
    const embed = new EmbedBuilder()
      .setAuthor({ name: author, iconURL: avatarURL })
      .setColor(config.discord.embedColor);
    if (thinking) embed.setFooter({ text: THINKING_TEXT });
    return embed;
  };

  return { make };
};
