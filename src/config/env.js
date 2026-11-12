import fs from 'node:fs';
import { loadEnvFile as nodeLoadEnvFile } from 'node:process';
import { createConfigError } from './errors.js';

// .env is optional: variables may come from the environment. Variables already set are not overridden.
export const loadEnvIfPresent = (path = '.env', { existsSync = fs.existsSync, loadEnvFile = nodeLoadEnvFile } = {}) => {
  if (!existsSync(path)) return false;
  try {
    loadEnvFile(path);
  } catch (error) {
    throw createConfigError(`Could not load ${path}: ${error.message}`);
  }
  return true;
};
