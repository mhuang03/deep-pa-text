import { toMessageRecord } from '../discord/messageRecord.js';
import { classifyMessages } from './classify.js';
import { listOwnWebhookIds } from './ownWebhooks.js';

const chunksOf = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const classify = async (ctx, messages, { channel, botMessageLookup }) => {
  const { getBotUserId, webhooks, logger, botMessageStore } = ctx;
  return classifyMessages(messages, {
    botUserId: getBotUserId(),
    ownWebhookIds: await listOwnWebhookIds({ webhooks, logger }, channel),
    isKnownBotMessage: (id) => Boolean(botMessageStore.getById(id) ?? botMessageLookup?.(id)),
  });
};

const isBotReference = ({ botMessageStore }, reference, botIds) =>
  reference !== null && (botIds.has(reference) || Boolean(botMessageStore.getById(reference)));

const buildEntries = (ctx, humans, botIds) => {
  const entries = [];
  let alreadyStored = 0;
  humans.forEach((message) => {
    const record = toMessageRecord(message);
    if (ctx.messageStore.hasRaw(record.id)) alreadyStored += 1;
    else entries.push({ record, repliesToBot: isBotReference(ctx, record.reference, botIds) });
  });
  return { entries, alreadyStored };
};

const ingestAll = async ({ ingest, logger, config }, entries) => {
  const totals = { insertedRaw: 0, kept: 0 };
  let done = 0;
  for (const batch of chunksOf(entries, config.backfill.batchSize)) {
    const { insertedRaw, kept } = await ingest.recordMessages(batch);
    totals.insertedRaw += insertedRaw;
    totals.kept += kept;
    done += batch.length;
    logger.info(`Imported ${done} of ${entries.length} messages.`);
  }
  return totals;
};

const countKept = ({ messageFilter }, entries) => ({
  insertedRaw: entries.length,
  kept: entries.filter(({ record }) => messageFilter.filter(record) !== null).length,
});

const importMessages = async (ctx, messages, { channel, dryRun = false, botMessageLookup = null }) => {
  const { humans, ownBot, otherBots } = await classify(ctx, messages, { channel, botMessageLookup });
  const botMessages = ctx.botMessageImporter.run(ownBot, { lookup: botMessageLookup ?? (() => null), dryRun });
  const { entries, alreadyStored } = buildEntries(ctx, humans, new Set(ownBot.map((m) => m.id)));
  const totals = dryRun ? countKept(ctx, entries) : await ingestAll(ctx, entries);
  return { otherBots, botMessages, alreadyStored, ...totals };
};

const run = async (ctx, { channel, before = null, limit = Infinity, dryRun = false, botMessageLookup = null }) => {
  const messages = await ctx.historyReader.readAll(channel, { before, limit });
  const result = await importMessages(ctx, messages, { channel, dryRun, botMessageLookup });
  return { fetched: messages.length, ...result };
};

export const createHistoryImporter = (deps) => ({
  importMessages: (messages, options) => importMessages(deps, messages, options),
  run: (options) => run(deps, options),
});
