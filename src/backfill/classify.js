const isOwn = (message, { botUserId, ownWebhookIds, isKnownBotMessage }) =>
  message.author.id === botUserId
  || (message.webhookId !== null && ownWebhookIds.has(message.webhookId))
  || isKnownBotMessage(message.id);

// Other applications' webhooks (proxy bots) are dropped; their display names must never be attributed.
export const classifyMessages = (messages, context) => {
  const humans = [];
  const ownBot = [];
  let otherBots = 0;
  messages.forEach((message) => {
    if (isOwn(message, context)) ownBot.push(message);
    else if (message.author.bot) otherBots += 1;
    else humans.push(message);
  });
  return { humans, ownBot, otherBots };
};
