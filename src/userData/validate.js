import { createConfigError } from '../config/errors.js';

const ID_PATTERN = /^\d{5,25}$/;
const PING_SECTIONS = ['users', 'roles', 'channels'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

const validateUser = (user, index, file) => {
  const where = `${file}: entry ${index + 1}`;
  if (!isPlainObject(user)) throw createConfigError(`${where} must be an object`);
  if (!isNonEmptyString(user.username)) throw createConfigError(`${where} needs a non-empty string "username"`);
  if (!isNonEmptyString(user.name)) throw createConfigError(`${where} (${user.username}) needs a non-empty string "name"`);
  if (user.id === undefined || user.id === null) return user;
  const id = typeof user.id === 'string' || typeof user.id === 'number' ? String(user.id) : '';
  if (!ID_PATTERN.test(id)) {
    throw createConfigError(`${where} (${user.username}) has an invalid "id": expected 5 to 25 digits`);
  }
  return { ...user, id };
};

const assertUniqueUsernames = (users, file) => {
  const seen = new Set();
  users.forEach(({ username }) => {
    const key = username.toLowerCase();
    if (seen.has(key)) throw createConfigError(`${file}: duplicate username "${username}" (usernames are compared ignoring case)`);
    seen.add(key);
  });
};

export const validateUsers = (raw, file) => {
  if (!Array.isArray(raw) || raw.length === 0) throw createConfigError(`${file} must be a non-empty array of users`);
  const users = raw.map((user, index) => validateUser(user, index, file));
  assertUniqueUsernames(users, file);
  return users;
};

export const validatePingCache = (raw, file) => {
  if (!isPlainObject(raw)) throw createConfigError(`${file} must be an object`);
  const sections = PING_SECTIONS.map((key) => {
    const value = raw[key] === undefined ? {} : raw[key];
    if (!isPlainObject(value)) throw createConfigError(`${file}: "${key}" must be an object`);
    return [key, value];
  });
  return { ...raw, ...Object.fromEntries(sections) };
};
