import fs from 'fs';

// Load users and build a set of valid usernames (only these will be counted)
const USERS_FILE = 'data/users.json';
export const USERS = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));

export const USERNAME_TO_NAME = {};
USERS.forEach(u => {
  USERNAME_TO_NAME[u.username] = u.name;
});

// load ping caches
const PING_CACHE_FILE = 'data/ping_caches.json';
export const PING_CACHE = JSON.parse(fs.readFileSync(PING_CACHE_FILE, 'utf-8'));