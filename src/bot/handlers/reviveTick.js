import { shouldRevive } from '../revivePolicy.js';
import { formatRevive } from '../logLines.js';

export const createReviveTick = (deps) => {
  const { client, config, activity, personaSelector, composer, clock, logger } = deps;

  const findGuild = async (channel) => channel.guild ?? client.guilds.fetch(channel.guildId);

  // Not awaited (spec 02 change 7): a failed send is logged, never unhandled.
  const sendLogged = (channel, payload) =>
    Promise.resolve(channel.send(payload)).catch((error) =>
      logger.error('Error sending revive message:', error));

  const revive = async () => {
    activity.noteBot();
    const channel = await client.channels.fetch(config.discord.channelId);
    const guild = await findGuild(channel);
    const persona = personaSelector.pickRandomUser();
    const { response, payload } = await composer.composeRevive({ persona, guild });
    sendLogged(channel, payload);
    activity.noteBot();
    logger.info(formatRevive({ persona, response }));
  };

  return async () => {
    try {
      if (!shouldRevive({ activity: activity.get(), nowMs: clock.now(), config })) return;
      await revive();
    } catch (error) {
      logger.error('Error in revive interval:', error);
    }
  };
};
