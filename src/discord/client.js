import { GatewayIntentBits } from 'discord.js';

export const CLIENT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

export const createDiscordClient = (Client) => new Client({ intents: CLIENT_INTENTS });
