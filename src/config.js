import * as base from './config/sections.js';
import * as feature from './config/featureSections.js';
import * as check from './config/validate.js';
import * as checkFeature from './config/validateFeatures.js';

export { DEFAULT_BUSY_TIMEOUT_MS } from './config/sections.js';
export { PERSONA_DISPLAYS } from './config/parse.js';
export { assertRequired, buildGifKeyWarning } from './config/requirements.js';
export { createConfigError, isConfigError } from './config/errors.js';
export {
  assertGifs, assertLlm, assertReply, assertFilter, assertStorage, assertRetrieval, assertPersona,
} from './config/validate.js';
export { assertChain, assertBurst, assertProfiles, assertBackfill } from './config/validateFeatures.js';

const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object') return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const buildConfig = (env) => ({
  discord: base.buildDiscord(env),
  reply: check.assertReply(base.buildReply(env)),
  revive: base.buildRevive(env),
  filter: check.assertFilter(base.buildFilter()),
  storage: check.assertStorage(base.buildStorage()),
  chroma: base.buildChroma(env),
  embedding: base.buildEmbedding(),
  retrieval: check.assertRetrieval(base.buildRetrieval()),
  persona: check.assertPersona(base.buildPersona()),
  llm: check.assertLlm(feature.buildLlm(env)),
  gifs: check.assertGifs(feature.buildGifs(env)),
  context: feature.buildContext(),
  chain: checkFeature.assertChain(feature.buildChain(env)),
  typing: feature.buildTyping(),
  burst: checkFeature.assertBurst(feature.buildBurst(env)),
  profiles: checkFeature.assertProfiles(feature.buildProfiles()),
  backfill: checkFeature.assertBackfill(feature.buildBackfill()),
  logging: feature.buildLogging(),
});

export const DEFAULTS = deepFreeze(buildConfig({}));

export const loadConfig = (env = {}) => deepFreeze(buildConfig(env));
