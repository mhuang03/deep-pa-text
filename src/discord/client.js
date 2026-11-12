import { GatewayIntentBits, Options, Partials } from 'discord.js';
import { SAFE_MENTIONS } from './payload.js';

const CLIENT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

// Partial messages let delete and edit events arrive for messages the client has not cached.
const CLIENT_PARTIALS = [Partials.Message];

// A bulk import would otherwise keep every fetched message in memory.
const NO_MESSAGE_CACHE = Options.cacheWithLimits({ MessageManager: 0 });

// Defence in depth: a send that forgets its own allowedMentions still cannot ping.
export const createDiscordClient = (Client, { cacheMessages = true } = {}) =>
  new Client({
    intents: CLIENT_INTENTS,
    partials: [...CLIENT_PARTIALS],
    allowedMentions: { parse: [...SAFE_MENTIONS.parse] },
    ...(cacheMessages ? {} : { makeCache: NO_MESSAGE_CACHE }),
  });
