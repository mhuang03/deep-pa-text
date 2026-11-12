import { toMessageRecord } from '../discord/messageRecord.js';
import { classifyMessages } from './classify.js';
import { listOwnWebhookIds } from './ownWebhooks.js';

// Classifies the fetched history against the old database and counts what the corpus filter would keep.
export const createReimportPlan = ({ messageFilter, webhooks, getBotUserId, logger }) => {
  const plan = async (messages, { channel, archive }) => {
    const { humans, ownBot, otherBots } = classifyMessages(messages, {
      botUserId: getBotUserId(),
      ownWebhookIds: await listOwnWebhookIds({ webhooks, logger }, channel),
      isKnownBotMessage: (id) => archive.botMessage(id) !== null,
    });
    const wouldKeep = humans.filter((message) => messageFilter.filter(toMessageRecord(message)) !== null).length;
    return {
      fetched: messages.length, humans: humans.length, ownBot: ownBot.length, otherBots, wouldKeep,
    };
  };

  return { plan };
};
