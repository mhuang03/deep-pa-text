export const NO_WEBHOOK_SUPPORT_MESSAGE = 'channel does not support webhooks';

// Caches the lookup promise per channel so concurrent sends share one lookup and never create duplicates.
export const createWebhookProvider = ({ getBotUserId, config }) => {
  const { webhookName } = config.discord;
  const cache = new Map();

  const requireSupport = (channel) => {
    if (typeof channel?.fetchWebhooks !== 'function') throw new Error(NO_WEBHOOK_SUPPORT_MESSAGE);
  };

  const ownedBy = (webhook) => webhook.owner?.id === getBotUserId();

  const lookup = async (channel) => {
    requireSupport(channel);
    const existing = [...(await channel.fetchWebhooks()).values()]
      .find((webhook) => ownedBy(webhook) && webhook.name === webhookName);
    return existing ?? channel.createWebhook({ name: webhookName });
  };

  const forget = (channel) => {
    cache.delete(channel.id);
  };

  const forChannel = (channel) => {
    const cached = cache.get(channel.id);
    if (cached) return cached;
    const promise = lookup(channel);
    cache.set(channel.id, promise);
    promise.catch(() => {
      if (cache.get(channel.id) === promise) cache.delete(channel.id);
    });
    return promise;
  };

  const ownedIds = async (channel) => {
    requireSupport(channel);
    const webhooks = [...(await channel.fetchWebhooks()).values()];
    return new Set(webhooks.filter(ownedBy).map((webhook) => webhook.id));
  };

  return { forChannel, forget, ownedIds };
};
