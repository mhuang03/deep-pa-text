import { shouldRevive } from '../revivePolicy.js';
import { TRIGGERS } from '../../util/triggers.js';
import { formatRevive, formatFailure, formatConversation } from '../logLines.js';

const findGuild = (client, channel) => channel.guild ?? client.guilds.fetch(channel.guildId);

const locate = async ({ client, config }) => {
  const channel = await client.channels.fetch(config.discord.channelId);
  return { channel, guild: await findGuild(client, channel) };
};

const sendRevive = async ({ responder, personaSelector }, { channel, guild, onDelivered }) => {
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
const attempt = async ({ activity }, work) => {
  const undo = activity.noteBot();
  const progress = { delivered: false };
  try {
    return await work(progress);
  } catch (error) {
    if (!progress.delivered) undo();
    throw error;
  }
};

const reviveInto = async (deps, { location, progress }) => {
  const onDelivered = () => {
    progress.delivered = true;
    deps.activity.noteBot();
  };
  const { persona, response } = await sendRevive(deps, { ...location, onDelivered });
  deps.logger.info(formatRevive({ persona, response }));
};

const revive = (deps) => attempt(deps, async (progress) => reviveInto(deps, {
  location: await locate(deps), progress,
}));

const playConversation = async (deps, { plan, location, progress }) => {
  const { conversationRunner, logger } = deps;
  const onFirstDelivered = () => {
    progress.delivered = true;
  };
  const { delivered } = await conversationRunner.run({ plan, ...location, onFirstDelivered });
  logger.info(formatConversation({
    topic: plan.topic, personas: plan.personas, delivered, planned: plan.turns.length,
  }));
};

// The reply hold starts before planning, so no auto reply begins during the topic call either; one
// activity claim covers the conversation or, when planning fails, the revive sent in its place.
const conversation = async (deps) => {
  const { conversationPlanner, replyPolicy, logger } = deps;
  const location = await locate(deps);
  const hold = replyPolicy.claim();
  try {
    await attempt(deps, async (progress) => {
      const plan = await conversationPlanner.plan({ channel: location.channel });
      if (!plan.failed) return playConversation(deps, { plan, location, progress });
      logger.info(`No conversation (${plan.failed}); sending a normal revive instead.`);
      return reviveInto(deps, { location, progress });
    });
  } finally {
    hold();
  }
};

const tick = async (deps, state) => {
  const { config, activity, clock, logger } = deps;
  if (state.running) return;
  state.running = true;
  try {
    if (clock.now() < state.cooldownUntil) return;
    if (!shouldRevive({ activity: activity.get(), nowMs: clock.now(), config })) return;
    await (deps.conversationPolicy.decide().start ? conversation(deps) : revive(deps));
  } catch (error) {
    state.cooldownUntil = clock.now() + config.revive.failureCooldownMs;
    logger.error(formatFailure({
      what: 'Error in revive interval', trigger: error?.trigger, persona: error?.persona, stage: error?.stage,
    }), error);
  } finally {
    state.running = false;
  }
};

// The cooldown is not persisted: a restart clears it.
export const createReviveTick = (deps) => {
  const state = { cooldownUntil: 0, running: false };
  return () => tick(deps, state);
};
