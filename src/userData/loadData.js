import fs from 'node:fs';
import { createConfigError } from '../config/errors.js';
import { validatePingCache, validateUsers } from './validate.js';

const readJson = (path, readFileSync) => {
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    throw createConfigError(`Cannot read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw createConfigError(`${path} is not valid JSON: ${error.message}`);
  }
};

export const loadData = ({ usersPath, pingCachePath }, { readFileSync = fs.readFileSync } = {}) => ({
  users: validateUsers(readJson(usersPath, readFileSync), usersPath),
  pingCache: validatePingCache(readJson(pingCachePath, readFileSync), pingCachePath),
});

export const buildUserDirectory = (users) => {
  const names = new Map(users.map((user) => [user.username, user.name]));
  const ids = new Map(users.filter((user) => user.id).map((user) => [user.username, String(user.id)]));
  return {
    users,
    usernames: new Set(names.keys()),
    nameOf: (username) => names.get(username),
    idOf: (username) => ids.get(username),
  };
};
