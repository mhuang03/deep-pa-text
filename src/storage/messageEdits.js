// Write operations of the message store: raw and corpus inserts, edits as new rows, soft deletes.
import { runInTransaction } from './transaction.js';

const GIF_TOKEN = '<gif!';

const resolveExplicit = (statements, reference) =>
  reference && statements.anchored.get(reference) ? reference : null;

// References hold logical ids; the previous visible row may be an edit row whose logical id is its source.
const inferReference = ({ statements, windowMs }, record) => {
  const previous = statements.previous.get(record.timestamp);
  if (!previous || previous.author === record.author) return null;
  if (record.timestamp - previous.timestamp >= windowMs) return null;
  const logical = previous.source_id ?? previous.id;
  return statements.rowExists.get(logical) ? logical : null;
};

const resolveReference = (ctx, record, shouldInfer) =>
  resolveExplicit(ctx.statements, record.reference) ?? (shouldInfer ? inferReference(ctx, record) : null);

const insertCorpusRow = ({ statements }, record, { rowId, sourceId, reference }) => {
  const hasGif = record.content.includes(GIF_TOKEN);
  const { changes } = statements.insertFiltered.run(
    rowId, record.author, record.content, record.timestamp, reference, hasGif ? 1 : 0, sourceId,
  );
  // A duplicate id inserts nothing; callers must not treat it as a new message.
  if (Number(changes) === 0) return null;
  return { ...record, id: rowId, reference, hasGif };
};

const markCorpus = ({ statements }, id, at) => Number(statements.markCorpus.run(at, id, id).changes) > 0;

// An edit never infers: it keeps the reference of the message's newest corpus row, or, when the message
// never had one, its explicit reference if that resolves. Read before the old rows are hidden.
const editReference = ({ statements }, id, filtered) => {
  const previous = statements.newestRow.get(id, id);
  return previous ? previous.reference : resolveExplicit(statements, filtered.reference);
};

// The first corpus row of a logical message takes its id (the anchor that references point at);
// later ones are <id>:<editedAt> with source_id set.
const editRowIds = ({ statements }, id, editedAt) => (statements.rowExists.get(id)
  ? { rowId: `${id}:${editedAt}`, sourceId: id }
  : { rowId: id, sourceId: null });

const applyInTransaction = (ctx, { id, content, editedAt, filtered }) => {
  if (Number(ctx.statements.insertRevision.run(id, content, editedAt).changes) === 0) return null;
  const reference = filtered ? editReference(ctx, id, filtered) : null;
  const ids = editRowIds(ctx, id, editedAt);
  markCorpus(ctx, id, editedAt);
  if (!filtered) return null;
  return insertCorpusRow(ctx, filtered, { ...ids, reference });
};

const softDelete = (ctx, id, at) => {
  const raw = Number(ctx.statements.markRaw.run(at, id).changes) > 0;
  return markCorpus(ctx, id, at) || raw;
};

export const createMessageEdits = ({ db, statements, windowMs }) => {
  const ctx = { statements, windowMs };
  return {
    insertRaw: (record) => Number(statements.insertRaw.run(
      record.id, record.author, record.content, record.timestamp, record.reference ?? null,
    ).changes) > 0,
    // Soft-deleted rows still exist, so a re-import does not resurrect them.
    hasRaw: (id) => statements.hasRaw.get(id) !== undefined,
    transaction: (fn) => runInTransaction(db, fn),
    // Replies to bot messages pass inferReference: false so they are not linked to an unrelated human message.
    insertFiltered: (record, { inferReference: shouldInfer = true } = {}) => insertCorpusRow(ctx, record, {
      rowId: record.id, sourceId: null, reference: resolveReference(ctx, record, shouldInfer),
    }),
    applyEdit: (edit) => runInTransaction(db, () => applyInTransaction(ctx, edit)),
    softDelete: (id, at) => softDelete(ctx, id, at),
  };
};
