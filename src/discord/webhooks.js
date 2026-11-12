const NO_WEBHOOK_SUPPORT_MESSAGE = 'channel does not support webhooks';

const requireSupport = (channel) => {
  if (typeof channel?.fetchWebhooks !== 'function') throw new Error(NO_WEBHOOK_SUPPORT_MESSAGE);
};

// Without a known bot id an ownerless webhook would match as ours, so nothing is looked up or created.
const requireBotUserId = ({ getBotUserId }) => {
  const id = getBotUserId();
  if (!id) throw new Error('bot user id is not known yet');
  return id;
};

const ownedBy = (webhook, botUserId) => webhook.owner?.id === botUserId;

const lookup = async (ctx, channel) => {
  const botUserId = requireBotUserId(ctx);
  requireSupport(channel);
  const name = ctx.config.discord.webhookName;
  const existing = [...(await channel.fetchWebhooks()).values()]
    .find((webhook) => ownedBy(webhook, botUserId) && webhook.name === name);
  return existing ?? channel.createWebhook({ name });
};

const forChannel = (ctx, channel) => {
  try {
    requireBotUserId(ctx);
  } catch (error) {
    return Promise.reject(error);
  }
  const cached = ctx.cache.get(channel.id);
  if (cached) return cached;
  const promise = lookup(ctx, channel);
  ctx.cache.set(channel.id, promise);
  promise.catch(() => {
    if (ctx.cache.get(channel.id) === promise) ctx.cache.delete(channel.id);
  });
  return promise;
};

const ownedIds = async (ctx, channel) => {
  const botUserId = requireBotUserId(ctx);
  requireSupport(channel);
  const webhooks = [...(await channel.fetchWebhooks()).values()];
  return new Set(webhooks.filter((webhook) => ownedBy(webhook, botUserId)).map((webhook) => webhook.id));
};

// Caches the lookup promise per channel so concurrent sends share one lookup and never create duplicates.
export const createWebhookProvider = ({ getBotUserId, config }) => {
  const ctx = { getBotUserId, config, cache: new Map() };
  return {
    forChannel: (channel) => forChannel(ctx, channel),
    forget: (channel) => {
      ctx.cache.delete(channel.id);
    },
    ownedIds: (channel) => ownedIds(ctx, channel),
  };
};
