import { shouldRevive } from '../revivePolicy.js';
import { TRIGGERS } from '../triggers.js';
import { formatRevive } from '../logLines.js';

export const createReviveTick = (deps) => {
  const { client, config, activity, personaSelector, responder, clock, logger } = deps;

  const findGuild = async (channel) => channel.guild ?? client.guilds.fetch(channel.guildId);

  const revive = async () => {
    activity.noteBot();
    const channel = await client.channels.fetch(config.discord.channelId);
    const guild = await findGuild(channel);
    const persona = personaSelector.pickRandomUser();
    const { response } = await responder.respond({
      trigger: TRIGGERS.REVIVE, persona, target: null, guild, via: { type: 'channel', channel },
    });
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
