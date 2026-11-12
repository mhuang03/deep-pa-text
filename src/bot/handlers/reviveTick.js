import { shouldRevive } from '../revivePolicy.js';
import { formatRevive } from '../logLines.js';
import { sendDetached } from '../detachedSend.js';

export const createReviveTick = (deps) => {
  const { client, config, activity, personaSelector, composer, clock, logger } = deps;

  const findGuild = async (channel) => channel.guild ?? client.guilds.fetch(channel.guildId);

  const sendLogged = (channel, payload) => sendDetached({
    send: () => channel.send(payload), logger, errorLabel: 'Error sending revive message:',
  });

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
