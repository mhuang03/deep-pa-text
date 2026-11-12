import { markVectorError } from '../util/vectorError.js';

const HAS_GIF_KEY = 'has_gif';
const MESSAGES = 'messages';
const REPLIES = 'replies';

const emptyCounts = () => ({ checked: 0, addedMessages: 0, filledMetadata: 0, addedReplies: 0, skipped: 0 });

const addCounts = (total, page) => Object.fromEntries(Object.keys(total).map((key) => [key, total[key] + page[key]]));

const lacksGifKey = (record) => record.metadata?.[HAS_GIF_KEY] === undefined;

// Upserting a row without its document or embedding would re-embed or blank it, so such rows are left alone.
const isIntact = (record) =>
  typeof record.document === 'string' && record.document !== ''
  && Array.isArray(record.embedding) && record.embedding.length > 0;

const hasEmbedding = (record) => Array.isArray(record?.embedding) && record.embedding.length > 0;

export const createVectorSync = ({ messageStore, vectorStore, logger, config }) => {
  const { batchSize } = config.backfill;

  const toFill = (row, record) => ({
    id: row.id,
    document: record.document,
    embedding: record.embedding,
    metadata: { ...record.metadata, [HAS_GIF_KEY]: row.hasGif },
  });

  // Adds the has_gif key to rows that lack it; returns how many were filled and how many were skipped.
  const fillGifKey = async (collection, rows, existing, dryRun) => {
    const candidates = rows.filter((row) => existing.has(row.id) && lacksGifKey(existing.get(row.id)));
    const usable = candidates.filter((row) => isIntact(existing.get(row.id)));
    if (!dryRun) await vectorStore.fillMetadata(collection, usable.map((row) => toFill(row, existing.get(row.id))));
    return { filled: usable.length, skipped: candidates.length - usable.length };
  };

  const syncMessages = async (rows, dryRun) => {
    const existing = await vectorStore.getRecords(MESSAGES, rows.map((row) => row.id));
    const missing = rows.filter((row) => !existing.has(row.id));
    // upsertMessages also writes the reply rows of what it adds.
    if (!dryRun && missing.length > 0) await vectorStore.upsertMessages(missing);
    const gif = await fillGifKey(MESSAGES, rows, existing, dryRun);
    return { missing, ...gif };
  };

  const addMissingReplies = async (rows, existingReplies, dryRun) => {
    const missing = rows.filter((row) => !existingReplies.has(row.id));
    if (missing.length === 0) return { added: 0, skipped: 0 };
    const references = Array.from(new Set(missing.map((row) => row.reference)));
    const parents = await vectorStore.getRecords(MESSAGES, references);
    const addable = missing.filter((row) => hasEmbedding(parents.get(row.reference)));
    if (!dryRun) {
      await vectorStore.addReplyRows(addable.map((message) => ({
        message, embedding: parents.get(message.reference).embedding,
      })));
    }
    return { added: addable.length, skipped: missing.length - addable.length };
  };

  const syncReplies = async (rows, dryRun) => {
    if (rows.length === 0) return { added: 0, skipped: 0, filled: 0 };
    const existing = await vectorStore.getRecords(REPLIES, rows.map((row) => row.id));
    const gif = await fillGifKey(REPLIES, rows, existing, dryRun);
    const added = await addMissingReplies(rows, existing, dryRun);
    return { added: added.added, skipped: added.skipped + gif.skipped, filled: gif.filled };
  };

  const syncPage = async (rows, dryRun) => {
    const messages = await syncMessages(rows, dryRun);
    // A dry run cannot see what the real run would add, so those rows are left out of the reply check.
    const unseen = dryRun ? new Set(messages.missing.map((row) => row.id)) : new Set();
    const withReference = rows.filter((row) => row.reference && !unseen.has(row.id));
    const replies = await syncReplies(withReference, dryRun);
    return {
      checked: rows.length,
      addedMessages: messages.missing.length,
      filledMetadata: messages.filled + replies.filled,
      addedReplies: replies.added,
      skipped: messages.skipped + replies.skipped,
    };
  };

  const run = async ({ dryRun = false } = {}) => {
    let totals = emptyCounts();
    let after = null;
    for (;;) {
      const rows = messageStore.pageFiltered({ after, limit: batchSize });
      if (rows.length === 0) return totals;
      totals = addCounts(totals, await syncPage(rows, dryRun));
      const last = rows.at(-1);
      after = { timestamp: last.timestamp, id: last.id };
      logger.info(`Checked ${totals.checked} corpus rows against Chroma.`);
    }
  };

  const guarded = async (options) => {
    try {
      return await run(options);
    } catch (error) {
      throw markVectorError(error);
    }
  };

  return { run: guarded };
};
