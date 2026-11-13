import { randomInt } from '../../util/random.js';
import { utcStamp } from '../../util/utcStamp.js';
import { createTopicCall } from './topicCall.js';
import { createPersonaDraw } from './personaDraw.js';
import { planTurns } from './turnOrder.js';

const ID_PREFIX = 'c';

// Degrades to no context: the topic call then only knows the time.
const reviveContext = async ({ contextBuilder, clock, logger }, channel) => {
  try {
    return await contextBuilder.forRevive({ channel, nowMs: clock.now() });
  } catch (error) {
    logger.warn('Could not build the context for a conversation topic; continuing without it:', error);
    return {};
  }
};

const gather = async (ctx, channel) => {
  const { conversationStore, topicSource, settings } = ctx;
  const recent = conversationStore.recent({ limit: settings.avoidRecentTopics });
  const excludeTopicIds = recent.map((row) => row.topicId).filter((id) => id !== null);
  const candidates = await topicSource.candidates({ limit: settings.topicCandidates, excludeTopicIds });
  if (candidates.length === 0) return null;
  const context = await reviveContext(ctx, channel);
  const openers = await topicSource.openers({ limit: settings.openerSamples });
  return { recent, candidates, context, openers };
};

const buildPlan = (ctx, { candidate, chosen, personas, context }) => {
  const { random, clock, settings } = ctx;
  const messages = randomInt(random, Math.max(settings.minMessages, personas.length), settings.maxMessages);
  return {
    id: `${ID_PREFIX}${utcStamp(clock.now())}`,
    topicId: candidate.topicId,
    topic: chosen.topic,
    premise: chosen.premise,
    personas,
    turns: planTurns({ personas, count: messages, random, attempts: settings.arrangeAttempts }),
    situation: { nowMs: clock.now(), quietMs: context.quietMs ?? null },
  };
};

// Chooses what the conversation is about, who takes part and who speaks when, and stores the plan.
export const createConversationPlanner = (deps) => {
  const { conversationStore, random, clock, config } = deps;
  const settings = config.conversation;
  const topicCall = createTopicCall(deps);
  const personaDraw = createPersonaDraw(deps);
  const ctx = { ...deps, settings };

  const plan = async ({ channel }) => {
    const gathered = await gather(ctx, channel);
    if (!gathered) return { failed: 'no-topics' };
    const { recent, candidates, context, openers } = gathered;
    const chosen = await topicCall.choose({
      now: clock.now(), context, recent: recent.map((row) => row.topic), candidates, openers,
    });
    if (!chosen) return { failed: 'topic-call' };
    const candidate = candidates[chosen.choice];
    const count = randomInt(random, settings.minPersonas, settings.maxPersonas);
    const personas = await personaDraw.draw({ candidate, count, query: `${chosen.topic}. ${chosen.premise}` });
    if (personas.length < settings.minPersonas) return { failed: 'too-few-personas' };
    const planned = buildPlan(ctx, { candidate, chosen, personas, context });
    conversationStore.insert(planned, clock.now());
    return planned;
  };

  return { plan };
};
