export const USERS = [
  { username: 'alice', name: 'Alice Example' },
  { username: 'bob', name: 'Bob Example' },
  { username: 'carol', name: 'Carol Example' },
  { username: 'dave', name: 'Dave Example' },
];

export const PING_CACHE = {
  users: { 111: 'alice', 222: 'bob' },
  roles: { 333: 'mods' },
  channels: { 444: 'general' },
};

export const ENV = {
  DISCORD_BOT_TOKEN: 'test-discord-token',
  DISCORD_CLIENT_ID: 'test-client-id',
  OPENAI_API_KEY: 'test-openai-key',
  DEEPSEEK_API_KEY: 'test-deepseek-key',
  GIPHY_API_KEY: 'test-giphy-key',
  HUMOR_API_KEY: 'test-humor-key',
  KLIPY_API_KEY: 'test-klipy-key',
  // Conversation tests switch it on; every other test keeps the revive path's rolls and LLM calls as they were.
  CONVERSATIONS: 'false',
};

export const CHANNEL_ID = '704837777564500149';
export const OTHER_CHANNEL_ID = '999';
export const GUILD_ID = '478743674826784769';

// 12:00 Central (CST), daytime
export const BASE_TIME = Date.parse('2026-11-12T18:00:00Z');
