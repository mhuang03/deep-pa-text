import { toMessageRecord } from '../discord/messageRecord.js';
import { classifyMessages } from './classify.js';
import { listOwnWebhookIds } from './ownWebhooks.js';

const chunksOf = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

export const createHistoryImporter = ({
  historyReader, botMessageImporter, ingest, messageStore, botMessageStore, messageFilter, webhooks,
  getBotUserId, config, logger,
}) => {
  const { batchSize } = config.backfill;

  const classify = async (messages, { channel, botMessageLookup }) => classifyMessages(messages, {
    botUserId: getBotUserId(),
    ownWebhookIds: await listOwnWebhookIds({ webhooks, logger }, channel),
    isKnownBotMessage: (id) => Boolean(botMessageStore.getById(id) ?? botMessageLookup?.(id)),
  });

  const isBotReference = (reference, botIds) =>
    reference !== null && (botIds.has(reference) || Boolean(botMessageStore.getById(reference)));

  const buildEntries = (humans, botIds) => {
    const entries = [];
    let alreadyStored = 0;
    humans.forEach((message) => {
      const record = toMessageRecord(message);
      if (messageStore.hasRaw(record.id)) alreadyStored += 1;
      else entries.push({ record, repliesToBot: isBotReference(record.reference, botIds) });
    });
    return { entries, alreadyStored };
  };

  const ingestAll = async (entries) => {
    const totals = { insertedRaw: 0, kept: 0 };
    let done = 0;
    for (const batch of chunksOf(entries, batchSize)) {
      const { insertedRaw, kept } = await ingest.recordMessages(batch);
      totals.insertedRaw += insertedRaw;
      totals.kept += kept;
      done += batch.length;
      logger.info(`Imported ${done} of ${entries.length} messages.`);
    }
    return totals;
  };

  const countKept = (entries) => ({
    insertedRaw: entries.length,
    kept: entries.filter(({ record }) => messageFilter.filter(record) !== null).length,
  });

  const importMessages = async (messages, { channel, dryRun = false, botMessageLookup = null }) => {
    const { humans, ownBot, otherBots } = await classify(messages, { channel, botMessageLookup });
    const botMessages = botMessageImporter.run(ownBot, { lookup: botMessageLookup ?? (() => null), dryRun });
    const { entries, alreadyStored } = buildEntries(humans, new Set(ownBot.map((m) => m.id)));
    const totals = dryRun ? countKept(entries) : await ingestAll(entries);
    return { otherBots, botMessages, alreadyStored, ...totals };
  };

  const run = async ({ channel, before = null, limit = Infinity, dryRun = false, botMessageLookup = null }) => {
    const messages = await historyReader.readAll(channel, { before, limit });
    const result = await importMessages(messages, { channel, dryRun, botMessageLookup });
    return { fetched: messages.length, ...result };
  };

  return { importMessages, run };
};
