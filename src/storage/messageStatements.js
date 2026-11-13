import * as sql from './messageSql.js';

const VISIBLE = 'deleted_at IS NULL';

const STATEMENTS = {
  insertRaw: sql.INSERT_RAW,
  insertFiltered: sql.INSERT_FILTERED,
  insertRevision: sql.INSERT_REVISION,
  previous: sql.PREVIOUS_VISIBLE,
  hasRaw: sql.HAS_RAW,
  page: sql.PAGE_FILTERED,
  rawById: sql.RAW_BY_ID,
  previousRaw: sql.PREVIOUS_RAW,
  newestRevision: sql.NEWEST_REVISION,
  anchored: sql.ANCHORED_VISIBLE,
  rowExists: sql.ROW_EXISTS,
  newestRow: sql.NEWEST_CORPUS_ROW,
  markRaw: sql.MARK_RAW_DELETED,
  markCorpus: sql.MARK_CORPUS_DELETED,
  random: sql.RANDOM_MESSAGES,
  starters: sql.RANDOM_STARTERS,
  burst: sql.BURST_STATS,
  latestRaw: sql.latestFrom('messages', VISIBLE),
  latestFiltered: sql.latestFrom('filtered_messages', VISIBLE),
  latestGif: sql.latestFrom('filtered_messages', `has_gif = 1 AND ${VISIBLE}`),
  latestRef: sql.LATEST_WITH_REFERENCE,
  newestRaw: sql.NEWEST_RAW,
  newestRawVisible: sql.NEWEST_RAW_VISIBLE,
};

export const prepareStatements = (db) =>
  Object.fromEntries(Object.entries(STATEMENTS).map(([name, text]) => [name, db.prepare(text)]));
