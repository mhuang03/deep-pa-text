export const createProfileRefresh = ({ client, config, memberProfiles, logger }) => async () => {
  try {
    const channel = await client.channels.fetch(config.discord.channelId);
    const guild = channel.guild ?? await client.guilds.fetch(channel.guildId);
    const counts = await memberProfiles.refreshAll(guild);
    logger.info(
      `Profile refresh: ${counts.checked} checked, ${counts.changed} changed, ${counts.failed} failed`,
    );
  } catch (error) {
    logger.error('Error refreshing member profiles:', error);
  }
};
