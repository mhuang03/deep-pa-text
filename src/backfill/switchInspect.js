// Read-only: reports where an interrupted or finished re-import left the database files.
import { SWITCH_STATES, STARTED_KEY, COMPLETED_KEY, switchPaths } from './switchState.js';

const TABLE_QUERY = "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?";
const JOURNAL_ADVICE =
  'the database was not closed cleanly. Start the bot and stop it cleanly (or open and close the database '
  + 'with sqlite3) so SQLite recovers it. Do not move or delete that file.';

const hasTable = (handle, name) => handle.prepare(TABLE_QUERY).get(name) !== undefined;
const blocked = (reason) => ({ state: SWITCH_STATES.BLOCKED, reason });

// A database from before the meta table simply has no keys.
const readMeta = ({ openDatabase, createMetaStore }, path) => {
  const handle = openDatabase(path, { readOnly: true });
  try {
    if (!hasTable(handle, 'meta')) return {};
    const meta = createMetaStore({ db: handle });
    return { started: meta.get(STARTED_KEY), completed: meta.get(COMPLETED_KEY) };
  } finally {
    handle.close();
  }
};

const inspectBackupExists = (ctx, paths) => {
  const { started, completed } = readMeta(ctx, paths.db);
  if (started && !completed) return { state: SWITCH_STATES.IN_PROGRESS, reason: null };
  return blocked(
    `${paths.backup} already exists next to a finished or ordinary database. Move ${paths.backup} to another `
    + 'place (it is a backup; nothing here deletes it), then run the re-import again.',
  );
};

const blockedByLeftovers = ({ fs }, paths) => {
  if (fs.existsSync(paths.partial)) {
    return blocked(
      `${paths.partial} is an incomplete backup left by an interrupted copy; it may be moved away `
      + '(nothing here deletes it). The database itself is untouched. Then run the re-import again.',
    );
  }
  const journal = paths.journals.find((file) => fs.existsSync(file));
  return journal ? blocked(`${journal} exists: ${JOURNAL_ADVICE}`) : null;
};

export const inspectSwitch = (ctx, db) => {
  const { fs } = ctx;
  const paths = switchPaths(db);
  if (!fs.existsSync(db)) {
    return blocked(`${db} does not exist. Use npm run backfill for a first import instead of a re-import.`);
  }
  const leftover = blockedByLeftovers(ctx, paths);
  if (leftover) return leftover;
  const hasNew = fs.existsSync(paths.fresh);
  const hasOld = fs.existsSync(paths.backup);
  if (hasNew && !hasOld) return { state: SWITCH_STATES.BEFORE_BACKUP, reason: null };
  if (hasNew) return { state: SWITCH_STATES.BEFORE_SWAP, reason: null };
  if (hasOld) return inspectBackupExists(ctx, paths);
  return { state: SWITCH_STATES.READY, reason: null };
};
