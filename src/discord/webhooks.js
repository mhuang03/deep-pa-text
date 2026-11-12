export const NO_WEBHOOK_SUPPORT_MESSAGE = 'channel does not support webhooks';

// Caches the lookup promise per channel so concurrent sends share one lookup and never create duplicates.
export const createWebhookProvider = ({ getBotUserId, config }) => {
  const { webhookName } = config.discord;
  const cache = new Map();

  const requireSupport = (channel) => {
    if (typeof channel?.fetchWebhooks !== 'function') throw new Error(NO_WEBHOOK_SUPPORT_MESSAGE);
  };

  // Without a known bot id an ownerless webhook would match as ours, so nothing is looked up or created.
  const requireBotUserId = () => {
    const id = getBotUserId();
    if (!id) throw new Error('bot user id is not known yet');
    return id;
  };

  const ownedBy = (webhook, botUserId) => webhook.owner?.id === botUserId;

  const lookup = async (channel) => {
    const botUserId = requireBotUserId();
    requireSupport(channel);
    const existing = [...(await channel.fetchWebhooks()).values()]
      .find((webhook) => ownedBy(webhook, botUserId) && webhook.name === webhookName);
    return existing ?? channel.createWebhook({ name: webhookName });
  };

  const forget = (channel) => {
    cache.delete(channel.id);
  };

  const forChannel = (channel) => {
    try {
      requireBotUserId();
    } catch (error) {
      return Promise.reject(error);
    }
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
    const botUserId = requireBotUserId();
    requireSupport(channel);
    const webhooks = [...(await channel.fetchWebhooks()).values()];
    return new Set(webhooks.filter((webhook) => ownedBy(webhook, botUserId)).map((webhook) => webhook.id));
  };

  return { forChannel, forget, ownedIds };
};
