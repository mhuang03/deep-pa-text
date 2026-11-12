import * as base from './config/sections.js';
import * as feature from './config/featureSections.js';
import * as check from './config/validate.js';
import * as checkFeature from './config/validateFeatures.js';

export { DEFAULT_BUSY_TIMEOUT_MS } from './config/sections.js';
export { PERSONA_DISPLAYS } from './config/parse.js';
export { assertRequired, buildGifKeyWarning } from './config/requirements.js';
export { secretsOf } from './config/secrets.js';
export { createConfigError, isConfigError } from './config/errors.js';
export {
  assertGifs, assertLlm, assertReply, assertRevive, assertDiscord, assertFilter, assertStorage, assertRetrieval, assertPersona, assertChroma,
} from './config/validate.js';
export { assertChain, assertCommand, assertBurst, assertProfiles, assertBackfill, assertLifecycle, assertCatchUp, assertVector } from './config/validateFeatures.js';

const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object') return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const buildConfig = (env) => ({
  discord: check.assertDiscord(base.buildDiscord(env)),
  reply: check.assertReply(base.buildReply(env)),
  revive: check.assertRevive(base.buildRevive(env)),
  filter: check.assertFilter(base.buildFilter()),
  storage: check.assertStorage(base.buildStorage()),
  chroma: check.assertChroma(base.buildChroma(env)),
  embedding: base.buildEmbedding(env),
  retrieval: check.assertRetrieval(base.buildRetrieval()),
  persona: check.assertPersona(base.buildPersona()),
  llm: check.assertLlm(feature.buildLlm(env)),
  gifs: check.assertGifs(feature.buildGifs(env)),
  context: feature.buildContext(),
  chain: checkFeature.assertChain(feature.buildChain(env)),
  command: checkFeature.assertCommand(feature.buildCommand()),
  typing: feature.buildTyping(),
  burst: checkFeature.assertBurst(feature.buildBurst(env)),
  profiles: checkFeature.assertProfiles(feature.buildProfiles()),
  backfill: checkFeature.assertBackfill(feature.buildBackfill()),
  lifecycle: checkFeature.assertLifecycle(feature.buildLifecycle()),
  catchUp: checkFeature.assertCatchUp(feature.buildCatchUp(env)),
  vector: checkFeature.assertVector(feature.buildVector()),
  logging: feature.buildLogging(),
});

export const DEFAULTS = deepFreeze(buildConfig({}));

export const loadConfig = (env = {}) => deepFreeze(buildConfig(env));
