import { createConfigError } from './errors.js';
import { readVariable } from './parse.js';

const GIF_VARIABLES = Object.freeze(['KLIPY_API_KEY', 'GIPHY_API_KEY', 'HUMOR_API_KEY']);

const REQUIRED = Object.freeze({
  bot: (config) => ['DISCORD_BOT_TOKEN', 'DEEPSEEK_API_KEY', config.embedding.apiKeyEnvVar],
  backfill: (config) => ['DISCORD_BOT_TOKEN', config.embedding.apiKeyEnvVar],
  reimport: (config) => ['DISCORD_BOT_TOKEN', config.embedding.apiKeyEnvVar],
  register: () => ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID'],
  'gif-smoke': () => [],
  inspect: () => [],
});

export const PURPOSES = Object.freeze(Object.keys(REQUIRED));

const fix = 'Set them in .env or the environment.';

const assertSomeGifKey = (env) => {
  if (GIF_VARIABLES.some((name) => readVariable(env, name) !== undefined)) return;
  throw createConfigError(
    `Missing required environment variables: at least one of ${GIF_VARIABLES.join(', ')}. ${fix}`,
  );
};

export const assertRequired = (config, env, purpose) => {
  const required = REQUIRED[purpose];
  if (!required) throw new Error(`Unknown startup purpose "${purpose}"; expected one of ${PURPOSES.join(', ')}`);
  const missing = required(config).filter((name) => readVariable(env, name) === undefined);
  if (missing.length > 0) {
    throw createConfigError(`Missing required environment variables: ${missing.join(', ')}. ${fix}`);
  }
  if (purpose === 'gif-smoke') assertSomeGifKey(env);
};

// Null when at least one GIF engine can run; otherwise the text of the startup warning.
export const buildGifKeyWarning = (config) => {
  const { klipyApiKey, giphyApiKey, humorApiKey } = config.gifs;
  if (klipyApiKey || giphyApiKey || humorApiKey) return null;
  return `No GIF API key is set (${GIF_VARIABLES.join(', ')}); GIF tokens in replies stay as placeholder text.`;
};
