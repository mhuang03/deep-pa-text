import { shouldRevive } from '../revivePolicy.js';
import { TRIGGERS } from '../triggers.js';
import { formatRevive, formatFailure } from '../logLines.js';

const findGuild = (client, channel) => channel.guild ?? client.guilds.fetch(channel.guildId);

const sendRevive = async (deps, onDelivered) => {
  const { client, config, responder, personaSelector } = deps;
  const channel = await client.channels.fetch(config.discord.channelId);
  const guild = await findGuild(client, channel);
  const persona = personaSelector.pickRandomUser();
  const { response } = await responder.respond({
    trigger: TRIGGERS.REVIVE,
    persona,
    target: null,
    guild,
    via: { type: 'channel', channel },
    channel,
    onDelivered,
  });
  return { persona, response };
};

// A failed attempt gives the activity back, so only the cooldown keeps an outage from retrying every check.
const revive = async (deps) => {
  const { activity, logger } = deps;
  const undo = activity.noteBot();
  let delivered = false;
  try {
    const onDelivered = () => {
      delivered = true;
      activity.noteBot();
    };
    const { persona, response } = await sendRevive(deps, onDelivered);
    logger.info(formatRevive({ persona, response }));
  } catch (error) {
    if (!delivered) undo();
    throw error;
  }
};

const tick = async (deps, state) => {
  const { config, activity, clock, logger } = deps;
  try {
    if (clock.now() < state.cooldownUntil) return;
    if (!shouldRevive({ activity: activity.get(), nowMs: clock.now(), config })) return;
    await revive(deps);
  } catch (error) {
    state.cooldownUntil = clock.now() + config.revive.failureCooldownMs;
    logger.error(formatFailure({
      what: 'Error in revive interval', trigger: error?.trigger, persona: error?.persona, stage: error?.stage,
    }), error);
  }
};

// The cooldown is not persisted: a restart clears it.
export const createReviveTick = (deps) => {
  const state = { cooldownUntil: 0 };
  return () => tick(deps, state);
};
