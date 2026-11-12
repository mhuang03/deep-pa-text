// Channel webhook fake: sending appends a bot-authored message to the channel history, like Discord does.
const OWNER_ID = 'bot-user';

const createFailer = () => {
  let error = null;
  let left = 0;
  return {
    arm: (failure, { times = 1 } = {}) => {
      error = failure;
      left = times;
    },
    check: () => {
      if (left <= 0) return;
      left -= 1;
      throw error;
    },
  };
};

const createWebhook = ({ id, name, ownerId }, { channel, nextId }) => {
  const failer = createFailer();
  const webhook = {
    id, name, owner: { id: ownerId }, sent: [], failSends: failer.arm,
  };
  webhook.send = async (payload) => {
    failer.check();
    webhook.sent.push(payload);
    const message = {
      id: nextId(),
      createdTimestamp: Date.now(),
      channel,
      embeds: payload.embeds,
      content: payload.content,
      reference: null,
      webhookId: id,
      author: { id, bot: true, username: payload.username },
    };
    channel.history.push(message);
    return message;
  };
  return webhook;
};

export const attachWebhooks = (channel, nextId) => {
  const fetchFailer = createFailer();
  const createFailerFor = createFailer();
  const list = new Map();
  let counter = 0;

  const add = ({ name, ownerId = OWNER_ID }) => {
    counter += 1;
    const webhook = createWebhook({ id: `webhook-${channel.id}-${counter}`, name, ownerId }, { channel, nextId });
    list.set(webhook.id, webhook);
    return webhook;
  };

  const webhooks = {
    list, fetches: 0, creates: [], add,
    failFetch: fetchFailer.arm,
    failCreate: createFailerFor.arm,
  };
  channel.webhooks = webhooks;
  channel.fetchWebhooks = async () => {
    webhooks.fetches += 1;
    fetchFailer.check();
    return new Map(list);
  };
  channel.createWebhook = async ({ name }) => {
    webhooks.creates.push({ name });
    createFailerFor.check();
    await Promise.resolve();
    return add({ name });
  };
};
