import { createConfigError } from './errors.js';

const PERSONA_DISPLAYS = Object.freeze(['embed', 'webhook']);

const MIN_PORT = 1;
const MAX_PORT = 65535;
const ID_PATTERN = /^\d{5,25}$/;
const DIGITS = /^\d+$/;

// An unset, empty or whitespace-only variable is treated as not set.
export const readVariable = (env, name) => {
  const raw = env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
};

export const parseBoolean = (env, name, fallback) => {
  const value = readVariable(env, name);
  if (value === undefined) return fallback;
  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  throw createConfigError(`${name} must be "true" or "false", got "${value}"`);
};

export const parsePort = (env, fallback) => {
  const value = readVariable(env, 'CHROMA_PORT');
  if (value === undefined) return fallback;
  const port = DIGITS.test(value) ? Number(value) : NaN;
  if (!(port >= MIN_PORT && port <= MAX_PORT)) {
    throw createConfigError(`CHROMA_PORT must be an integer from ${MIN_PORT} to ${MAX_PORT}, got "${value}"`);
  }
  return port;
};

export const parseId = (env, name, fallback) => {
  const value = readVariable(env, name);
  if (value === undefined) return fallback;
  if (!ID_PATTERN.test(value)) throw createConfigError(`${name} must be a Discord id (5 to 25 digits), got "${value}"`);
  return value;
};

export const parsePersonaDisplay = (env, fallback) => {
  const value = readVariable(env, 'PERSONA_DISPLAY');
  if (value === undefined) return fallback;
  if (!PERSONA_DISPLAYS.includes(value)) {
    throw createConfigError(`PERSONA_DISPLAY must be one of ${PERSONA_DISPLAYS.join(', ')}, got "${value}"`);
  }
  return value;
};
