import { shouldRevive } from '../revivePolicy.js';
import { TRIGGERS } from '../triggers.js';
import { formatRevive } from '../logLines.js';

export const createReviveTick = (deps) => {
  const { client, config, activity, personaSelector, responder, clock, logger } = deps;

  // Not persisted: a restart clears it.
  let cooldownUntil = 0;

  const findGuild = async (channel) => channel.guild ?? client.guilds.fetch(channel.guildId);

  // A failed attempt gives the activity back, so only the cooldown keeps an outage from retrying every check.
  const revive = async () => {
    const undo = activity.noteBot();
    let delivered = false;
    try {
      const channel = await client.channels.fetch(config.discord.channelId);
      const guild = await findGuild(channel);
      const persona = personaSelector.pickRandomUser();
      const onDelivered = () => {
        delivered = true;
        activity.noteBot();
      };
      const { response } = await responder.respond({
        trigger: TRIGGERS.REVIVE,
        persona,
        target: null,
        guild,
        via: { type: 'channel', channel },
        channel,
        onDelivered,
      });
      logger.info(formatRevive({ persona, response }));
    } catch (error) {
      if (!delivered) undo();
      throw error;
    }
  };

  const isCoolingDown = () => clock.now() < cooldownUntil;

  return async () => {
    try {
      if (isCoolingDown()) return;
      if (!shouldRevive({ activity: activity.get(), nowMs: clock.now(), config })) return;
      await revive();
    } catch (error) {
      cooldownUntil = clock.now() + config.revive.failureCooldownMs;
      logger.error('Error in revive interval:', error);
    }
  };
};
