import fs from 'node:fs';

const readJson = (path) => JSON.parse(fs.readFileSync(path, 'utf-8'));

export const loadData = ({ usersPath, pingCachePath }) => ({
  users: readJson(usersPath),
  pingCache: readJson(pingCachePath),
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
