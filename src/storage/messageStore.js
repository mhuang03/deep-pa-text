import * as sql from './messageSql.js';

const CHUNK_SIZE = 500;
const GIF_TOKEN = '<gif!';
const VISIBLE = 'deleted_at IS NULL';
// Sorts before every real (timestamp, id) pair, so the first page starts at the beginning.
const NO_CURSOR = { timestamp: -1, id: '' };

const chunksOf = (items) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    chunks.push(items.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
};

export const createMessageStore = ({ db, config }) => {
  const windowMs = config.storage.inferredReferenceWindowMs;
  const insertRawSql = db.prepare(sql.INSERT_RAW);
  const insertFilteredSql = db.prepare(sql.INSERT_FILTERED);
  const insertRevisionSql = db.prepare(sql.INSERT_REVISION);
  const previousSql = db.prepare(sql.PREVIOUS_VISIBLE);
  const hasRawSql = db.prepare(sql.HAS_RAW);
  const pageSql = db.prepare(sql.PAGE_FILTERED);
  const rawByIdSql = db.prepare(sql.RAW_BY_ID);
  const newestRevisionSql = db.prepare(sql.NEWEST_REVISION);
  const anchoredSql = db.prepare(sql.ANCHORED_VISIBLE);
  const rowExistsSql = db.prepare(sql.ROW_EXISTS);
  const newestRowSql = db.prepare(sql.NEWEST_CORPUS_ROW);
  const markRawSql = db.prepare(sql.MARK_RAW_DELETED);
  const markCorpusSql = db.prepare(sql.MARK_CORPUS_DELETED);
  const randomSql = db.prepare(sql.RANDOM_MESSAGES);
  const startersSql = db.prepare(sql.RANDOM_STARTERS);
  const burstSql = db.prepare(sql.BURST_STATS);
  const latestRawSql = db.prepare(sql.latestFrom('messages', VISIBLE));
  const latestFilteredSql = db.prepare(sql.latestFrom('filtered_messages', VISIBLE));
  const latestGifSql = db.prepare(sql.latestFrom('filtered_messages', `has_gif = 1 AND ${VISIBLE}`));
  const latestRefSql = db.prepare(sql.LATEST_WITH_REFERENCE);
  const newestRawSql = db.prepare(sql.NEWEST_RAW);
  const newestRawVisibleSql = db.prepare(sql.NEWEST_RAW_VISIBLE);

  const resolveExplicit = (reference) =>
    reference && anchoredSql.get(reference) ? reference : null;

  // References hold logical ids; the previous visible row may be an edit row whose logical id is its source.
  const inferReference = (record) => {
    const previous = previousSql.get(record.timestamp);
    if (!previous || previous.author === record.author) return null;
    if (record.timestamp - previous.timestamp >= windowMs) return null;
    const logical = previous.source_id ?? previous.id;
    return rowExistsSql.get(logical) ? logical : null;
  };

  const resolveReference = (record, shouldInfer) =>
    resolveExplicit(record.reference) ?? (shouldInfer ? inferReference(record) : null);

  const insertRaw = (record) => {
    const { changes } = insertRawSql.run(
      record.id, record.author, record.content, record.timestamp, record.reference ?? null,
    );
    return Number(changes) > 0;
  };

  // Soft-deleted rows still exist, so a re-import does not resurrect them.
  const hasRaw = (id) => hasRawSql.get(id) !== undefined;

  // fn must be synchronous: the connection is shared, so awaiting inside would interleave other writes.
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const insertCorpusRow = (record, { rowId, sourceId, reference }) => {
    const hasGif = record.content.includes(GIF_TOKEN);
    const { changes } = insertFilteredSql.run(
      rowId, record.author, record.content, record.timestamp, reference, hasGif ? 1 : 0, sourceId,
    );
    // A duplicate id inserts nothing; callers must not treat it as a new message.
    if (Number(changes) === 0) return null;
    return { ...record, id: rowId, reference, hasGif };
  };

  // Replies to bot messages pass inferReference: false so they are not linked to an unrelated human message.
  const insertFiltered = (record, { inferReference: shouldInfer = true } = {}) =>
    insertCorpusRow(record, {
      rowId: record.id, sourceId: null, reference: resolveReference(record, shouldInfer),
    });

  const markCorpus = (id, at) => Number(markCorpusSql.run(at, id, id).changes) > 0;

  const softDelete = (id, at) => {
    const raw = Number(markRawSql.run(at, id).changes) > 0;
    return markCorpus(id, at) || raw;
  };

  // An edit never infers: it keeps the reference of the message's newest corpus row, or, when the message
  // never had one, its explicit reference if that resolves. Read before the old rows are hidden.
  const editReference = (id, filtered) => {
    const previous = newestRowSql.get(id, id);
    return previous ? previous.reference : resolveExplicit(filtered.reference);
  };

  // The first corpus row of a logical message takes its id (the anchor that references point at);
  // later ones are <id>:<editedAt> with source_id set.
  const editRowIds = (id, editedAt) => (rowExistsSql.get(id)
    ? { rowId: `${id}:${editedAt}`, sourceId: id }
    : { rowId: id, sourceId: null });

  const applyInTransaction = ({ id, content, editedAt, filtered }) => {
    if (Number(insertRevisionSql.run(id, content, editedAt).changes) === 0) return null;
    const reference = filtered ? editReference(id, filtered) : null;
    const ids = editRowIds(id, editedAt);
    markCorpus(id, editedAt);
    if (!filtered) return null;
    return insertCorpusRow(filtered, { ...ids, reference });
  };

  const applyEdit = (edit) => transaction(() => applyInTransaction(edit));

  const pageFiltered = ({ after = null, limit }) => {
    const { timestamp, id } = after ?? NO_CURSOR;
    return pageSql.all(timestamp, id, limit).map((row) => ({
      id: row.id,
      author: row.author,
      content: row.content,
      timestamp: row.timestamp,
      reference: row.reference,
      hasGif: Boolean(row.has_gif),
    }));
  };

  const randomMessages = ({ author, before = null, limit }) =>
    randomSql.all(author, before, before, limit).map((row) => ({ id: row.id, content: row.content }));

  const randomStarters = ({ author, minGapMs, limit }) =>
    startersSql.all(author, minGapMs, limit).map((row) => row.content);

  const burstStats = ({ author, windowMs: burstWindowMs }) => {
    const { samples, rate } = burstSql.get(burstWindowMs, author);
    return { samples: Number(samples), rate: Number(rate) };
  };

  // Ids whose reference does not resolve to a visible message are simply absent.
  const getParents = (ids) => {
    const parents = new Map();
    chunksOf(ids).forEach((chunk) => {
      db.prepare(sql.parentsSql(chunk.length)).all(...chunk)
        .forEach((row) => parents.set(row.id, { content: row.content }));
    });
    return parents;
  };

  // Row ids that exist but are no longer visible; unknown ids are not hidden.
  const hiddenIds = (rowIds) => {
    const hidden = new Set();
    chunksOf(Array.from(new Set(rowIds))).forEach((chunk) => {
      db.prepare(sql.hiddenSql(chunk.length)).all(...chunk).forEach((row) => hidden.add(row.id));
    });
    return hidden;
  };

  // Exact-content counts; contents never sent before the cutoff are absent from the map.
  const countContents = ({ author, contents, before }) => {
    const counts = new Map();
    chunksOf(Array.from(new Set(contents))).forEach((chunk) => {
      db.prepare(sql.countsSql(chunk.length)).all(author, before, ...chunk)
        .forEach((row) => counts.set(row.content, row.times));
    });
    return counts;
  };

  const getRaw = (id) => {
    const row = rawByIdSql.get(id);
    if (!row) return null;
    const { deleted_at: deletedAt, ...rest } = row;
    const revision = newestRevisionSql.get(id);
    return { ...rest, content: revision?.content ?? rest.content, deleted: deletedAt !== null };
  };

  const newestRaw = ({ includeDeleted = false } = {}) => {
    const row = (includeDeleted ? newestRawSql : newestRawVisibleSql).get();
    return row ? { id: row.id, timestamp: row.timestamp } : null;
  };

  return {
    insertRaw,
    newestRaw,
    hasRaw,
    transaction,
    pageFiltered,
    getRaw,
    countContents,
    getParents,
    hiddenIds,
    insertFiltered,
    applyEdit,
    softDelete,
    randomMessages,
    randomStarters,
    burstStats,
    latestRaw: (limit) => latestRawSql.all(limit),
    latestFiltered: (limit) => latestFilteredSql.all(limit),
    latestWithReference: (limit) => latestRefSql.all(limit),
    latestWithGif: (limit) => latestGifSql.all(limit),
  };
};
