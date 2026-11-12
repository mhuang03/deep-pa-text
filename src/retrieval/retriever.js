import { dedupeBuckets } from './dedupe.js';
import { buildFrequent } from './frequency.js';
import { fetchRaw, fetchLimit } from './retrieverFetch.js';

export const BUCKET_ORDER = ['replies', 'similar', 'gifs', 'other'];

const withEmbeddings = (candidates, embeddings) =>
  candidates.map((candidate) => ({ ...candidate, embedding: embeddings.get(candidate.id) ?? null }));

const dedupeOptions = ({ nearDuplicateThreshold, nearDuplicateMinChars }) => ({
  nearDuplicateThreshold, nearDuplicateMinChars,
});

// Embeddings are optional: without them dedup falls back to normalised keys.
const loadEmbeddings = async ({ vectorStore, logger }, ids) => {
  try {
    return await vectorStore.getEmbeddings(ids);
  } catch (error) {
    logger?.warn?.(`Could not load embeddings for dedup: ${error.message}`);
    return new Map();
  }
};

const dedupeRaw = async (ctx, raw) => {
  const { retrieval } = ctx;
  const ids = Array.from(new Set(BUCKET_ORDER.flatMap((key) => raw[key].map((c) => c.id))));
  const embeddings = await loadEmbeddings(ctx, ids);
  const limits = [retrieval.replyResults, retrieval.similarResults, retrieval.gifResults, retrieval.otherResults];
  const deduped = dedupeBuckets(
    BUCKET_ORDER.map((key) => withEmbeddings(raw[key], embeddings)), { ...dedupeOptions(retrieval), limits },
  );
  return Object.fromEntries(BUCKET_ORDER.map((key, i) => [key, deduped[i]]));
};

const countAll = ({ messageStore }, { author, kept, before }) => {
  const contents = BUCKET_ORDER.flatMap((key) => kept[key].flatMap((item) => item.variants));
  return messageStore.countContents({ author, contents, before });
};

const buildReplyExamples = ({ messageStore }, items) => {
  const parents = messageStore.getParents(items.map((item) => item.id));
  return items.map((item) => ({ you: item.text, them: parents.get(item.id)?.content ?? null }));
};

const retrieveForReply = async (ctx, { author, record, queryText }) => {
  const embedding = await ctx.vectorStore.embed(queryText ?? record.content);
  const kept = await dedupeRaw(ctx, await fetchRaw(ctx, { author, record, embedding }));
  const counts = countAll(ctx, { author, kept, before: record.timestamp });
  const frequent = buildFrequent(BUCKET_ORDER.flatMap((key) => kept[key]), counts, ctx.retrieval);
  const texts = (key) => kept[key].map((item) => item.text);
  return {
    replies: buildReplyExamples(ctx, kept.replies),
    similar: texts('similar'),
    gifs: texts('gifs'),
    other: texts('other'),
    frequent,
  };
};

const retrieveForRevive = async ({ messageStore, retrieval }, author) => {
  const rows = messageStore.randomMessages({ author, limit: fetchLimit(retrieval, retrieval.reviveSamples) });
  const candidates = rows.map(({ id, content }) => ({ id, text: content, embedding: null }));
  const [kept] = dedupeBuckets([candidates], { ...dedupeOptions(retrieval), limits: [retrieval.reviveSamples] });
  return kept.map((item) => item.text);
};

export const createRetriever = ({ vectorStore, messageStore, config, logger }) => {
  const ctx = { vectorStore, messageStore, retrieval: config.retrieval, logger };
  return {
    retrieveForReply: (author, record, { queryText } = {}) => retrieveForReply(ctx, { author, record, queryText }),
    retrieveForRevive: (author) => retrieveForRevive(ctx, author),
  };
};
