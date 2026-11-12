import { GatewayIntentBits } from 'discord.js';
import { SAFE_MENTIONS } from './payload.js';

export const CLIENT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

// Defence in depth: a send that forgets its own allowedMentions still cannot ping.
export const createDiscordClient = (Client) =>
  new Client({ intents: CLIENT_INTENTS, allowedMentions: { parse: [...SAFE_MENTIONS.parse] } });
