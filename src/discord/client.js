import { GatewayIntentBits, Partials } from 'discord.js';
import { SAFE_MENTIONS } from './payload.js';

export const CLIENT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

// Partial messages let delete and edit events arrive for messages the client has not cached.
export const CLIENT_PARTIALS = [Partials.Message];

// Defence in depth: a send that forgets its own allowedMentions still cannot ping.
export const createDiscordClient = (Client) =>
  new Client({ intents: CLIENT_INTENTS, partials: [...CLIENT_PARTIALS], allowedMentions: { parse: [...SAFE_MENTIONS.parse] } });
