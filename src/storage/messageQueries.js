// Read queries of the message store. Chunked lookups keep each statement under SQLite's variable limit.
import * as sql from './messageSql.js';

// Sorts before every real (timestamp, id) pair, so the first page starts at the beginning.
const NO_CURSOR = { timestamp: -1, id: '' };

const chunksOf = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const toCorpusRow = (row) => ({
  id: row.id,
  author: row.author,
  content: row.content,
  timestamp: row.timestamp,
  reference: row.reference,
  hasGif: Boolean(row.has_gif),
});

// Ids whose reference does not resolve to a visible message are simply absent.
const getParents = ({ db, chunkSize }, ids) => {
  const parents = new Map();
  chunksOf(ids, chunkSize).forEach((chunk) => {
    db.prepare(sql.parentsSql(chunk.length)).all(...chunk)
      .forEach((row) => parents.set(row.id, { content: row.content }));
  });
  return parents;
};

// Row ids that exist but are no longer visible; unknown ids are not hidden.
const hiddenIds = ({ db, chunkSize }, rowIds) => {
  const hidden = new Set();
  chunksOf(Array.from(new Set(rowIds)), chunkSize).forEach((chunk) => {
    db.prepare(sql.hiddenSql(chunk.length)).all(...chunk).forEach((row) => hidden.add(row.id));
  });
  return hidden;
};

// Exact-content counts; contents never sent before the cutoff are absent from the map.
const countContents = ({ db, chunkSize }, { author, contents, before }) => {
  const counts = new Map();
  chunksOf(Array.from(new Set(contents)), chunkSize).forEach((chunk) => {
    db.prepare(sql.countsSql(chunk.length)).all(author, before, ...chunk)
      .forEach((row) => counts.set(row.content, row.times));
  });
  return counts;
};

const getRaw = ({ statements }, id) => {
  const row = statements.rawById.get(id);
  if (!row) return null;
  const { deleted_at: deletedAt, ...rest } = row;
  const revision = statements.newestRevision.get(id);
  return { ...rest, content: revision?.content ?? rest.content, deleted: deletedAt !== null };
};

const newestRaw = ({ statements }, { includeDeleted = false } = {}) => {
  const row = (includeDeleted ? statements.newestRaw : statements.newestRawVisible).get();
  return row ? { id: row.id, timestamp: row.timestamp } : null;
};

const pageFiltered = ({ statements }, { after = null, limit }) => {
  const { timestamp, id } = after ?? NO_CURSOR;
  return statements.page.all(timestamp, id, limit).map(toCorpusRow);
};

const burstStats = ({ statements }, { author, windowMs }) => {
  const { samples, rate } = statements.burst.get(windowMs, author);
  return { samples: Number(samples), rate: Number(rate) };
};

export const createMessageQueries = ({ db, statements, chunkSize }) => {
  const ctx = { db, statements, chunkSize };
  return {
    pageFiltered: (options) => pageFiltered(ctx, options),
    getRaw: (id) => getRaw(ctx, id),
    newestRaw: (options) => newestRaw(ctx, options),
    countContents: (options) => countContents(ctx, options),
    getParents: (ids) => getParents(ctx, ids),
    hiddenIds: (rowIds) => hiddenIds(ctx, rowIds),
    randomMessages: ({ author, before = null, limit }) =>
      statements.random.all(author, before, before, limit).map((row) => ({ id: row.id, content: row.content })),
    randomStarters: ({ author, minGapMs, limit }) =>
      statements.starters.all(author, minGapMs, limit).map((row) => row.content),
    burstStats: (options) => burstStats(ctx, options),
    latestRaw: (limit) => statements.latestRaw.all(limit),
    latestFiltered: (limit) => statements.latestFiltered.all(limit),
    latestWithReference: (limit) => statements.latestRef.all(limit),
    latestWithGif: (limit) => statements.latestGif.all(limit),
  };
};
