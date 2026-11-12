// Without Manage Webhooks only webhook messages already known by id are recognised as ours.
export const listOwnWebhookIds = async ({ webhooks, logger }, channel) => {
  try {
    return await webhooks.ownedIds(channel);
  } catch (error) {
    logger.warn('Could not list the bot webhooks; only known webhook messages count as the bot\'s own:', error);
    return new Set();
  }
};
