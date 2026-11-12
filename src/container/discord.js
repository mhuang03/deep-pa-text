import { createDiscordClient } from '../discord/client.js';
import { createChannelHistory } from '../discord/channelHistory.js';
import { createAuthorEmbeds } from '../discord/authorEmbed.js';
import { createEmbedDelivery } from '../discord/delivery.js';
import { fetchMember } from '../discord/memberLookup.js';
import { createWebhookProvider } from '../discord/webhooks.js';
import { createWebhookDelivery } from '../discord/webhookDelivery.js';
import { createMemberProfiles } from '../profiles/memberProfiles.js';
import { createBotMessageResolver } from '../bot/botMessageResolver.js';
import { createContextBuilder } from '../context/contextBuilder.js';

const buildDelivery = ({ config, client, memberProfiles, logger }) => {
  const authorEmbeds = createAuthorEmbeds({ config, memberProfiles });
  const embedDelivery = createEmbedDelivery({ authorEmbeds, config });
  const webhooks = createWebhookProvider({ getBotUserId: () => client.user?.id, config });
  if (config.discord.personaDisplay !== 'webhook') return { delivery: embedDelivery, webhooks };
  const delivery = createWebhookDelivery({
    webhooks, memberProfiles, fallback: embedDelivery, config, logger,
  });
  return { delivery, webhooks };
};

// The Discord client and everything that reads or writes through it.
export const buildDiscord = ({ config, vendor, clock, logger, cacheMessages, given, storage }) => {
  const client = given ?? createDiscordClient(vendor.Client, { cacheMessages });
  const { botMessageStore, userDirectory, profileStore, messageFilter } = storage;
  const memberProfiles = createMemberProfiles({
    profileStore, fetchMember, userDirectory, config, clock, logger,
  });
  const { delivery, webhooks } = buildDelivery({ config, client, memberProfiles, logger });
  const botMessageResolver = createBotMessageResolver({
    botMessageStore, userDirectory, getBotUserId: () => client.user?.id,
  });
  const channelHistory = createChannelHistory({ logger });
  const contextBuilder = createContextBuilder({ channelHistory, botMessageResolver, messageFilter, config });
  return { client, memberProfiles, delivery, webhooks, botMessageResolver, channelHistory, contextBuilder };
};
