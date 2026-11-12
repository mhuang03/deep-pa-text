import { normalizeForDedup } from '../text/normalize.js';
import { REVIVE_SYSTEM_PROMPT, buildRevivePrompt } from './prompts.js';

const generateRevive = async (deps, persona, context) => {
  const { complete, retriever, userDirectory, inputs, config } = deps;
  const starters = inputs.starters(persona);
  const taken = new Set(starters.map(normalizeForDedup));
  const examples = (await retriever.retrieveForRevive(persona))
    .filter((text) => !taken.has(normalizeForDedup(text)));
  const user = buildRevivePrompt({
    author: persona,
    name: userDirectory.nameOf(persona),
    examples,
    starters,
    transcript: context.transcript ?? [],
    quietMs: context.quietMs ?? null,
    nowMs: context.nowMs,
    timeZone: config.context.timeZone,
    recentBotMessages: inputs.recentBotMessages(),
    burstRate: inputs.burstRate(persona),
    burst: config.burst,
  });
  return complete(user, REVIVE_SYSTEM_PROMPT);
};

export const createReviveGenerator = (deps) => ({
  generateRevive: (persona, context = {}) => generateRevive(deps, persona, context),
});
