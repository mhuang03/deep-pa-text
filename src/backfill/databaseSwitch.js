// The only module that moves database files. Nothing is deleted or overwritten: the old database
// is hard-linked (or copied via <db>.old.tmp and an atomic rename) to <db>.old, and the new one replaces
// it by an atomic rename. A backup is verified against the original before every swap.
import { verifyBackupFile } from './backupVerifier.js';


const NEW_SUFFIX = '.new';
const OLD_SUFFIX = '.old';
const PARTIAL_SUFFIX = '.old.tmp';
const JOURNAL_SUFFIXES = ['-journal', '-wal', '-shm'];
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EXDEV']);
const STARTED_KEY = 'reimport_started_at';
const COMPLETED_KEY = 'reimport_completed_at';
const GENERATION_KEY = 'chroma_generation';
const TABLE_QUERY = "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?";
const JOURNAL_ADVICE =
  'the database was not closed cleanly. Start the bot and stop it cleanly (or open and close the database '
  + 'with sqlite3) so SQLite recovers it. Do not move or delete that file.';

export const SWITCH_STATES = Object.freeze({
  READY: 'ready',
  BEFORE_BACKUP: 'interrupted-before-backup',
  BEFORE_SWAP: 'interrupted-before-swap',
  IN_PROGRESS: 'in-progress',
  BLOCKED: 'blocked',
});

export const switchPaths = (db) => ({
  db, fresh: `${db}${NEW_SUFFIX}`, backup: `${db}${OLD_SUFFIX}`, partial: `${db}${PARTIAL_SUFFIX}`, journals: JOURNAL_SUFFIXES.map((s) => `${db}${s}`),
});

const hasTable = (handle, name) => handle.prepare(TABLE_QUERY).get(name) !== undefined;

export const createDatabaseSwitch = ({ fs, openDatabase: open, createMetaStore, logger, busyTimeoutMs }) => {
  const openDatabase = (path, options = {}) => open(path, { ...options, busyTimeoutMs });
  const blocked = (reason) => ({ state: SWITCH_STATES.BLOCKED, reason });

  // A database from before the meta table simply has no keys.
  const readMeta = (path) => {
    const handle = openDatabase(path, { readOnly: true });
    try {
      if (!hasTable(handle, 'meta')) return {};
      const meta = createMetaStore({ db: handle });
      return { started: meta.get(STARTED_KEY), completed: meta.get(COMPLETED_KEY) };
    } finally {
      handle.close();
    }
  };

  const inspectBackupExists = (paths) => {
    const { started, completed } = readMeta(paths.db);
    if (started && !completed) return { state: SWITCH_STATES.IN_PROGRESS, reason: null };
    return blocked(
      `${paths.backup} already exists next to a finished or ordinary database. Move ${paths.backup} to another `
      + 'place (it is a backup; nothing here deletes it), then run the re-import again.',
    );
  };

  const inspect = (db) => {
    const paths = switchPaths(db);
    if (!fs.existsSync(db)) {
      return blocked(`${db} does not exist. Use npm run backfill for a first import instead of a re-import.`);
    }
    if (fs.existsSync(paths.partial)) {
      return blocked(
        `${paths.partial} is an incomplete backup left by an interrupted copy; it may be moved away `
        + '(nothing here deletes it). The database itself is untouched. Then run the re-import again.',
      );
    }
    const journal = paths.journals.find((file) => fs.existsSync(file));
    if (journal) return blocked(`${journal} exists: ${JOURNAL_ADVICE}`);
    const hasNew = fs.existsSync(paths.fresh);
    const hasOld = fs.existsSync(paths.backup);
    if (hasNew && !hasOld) return { state: SWITCH_STATES.BEFORE_BACKUP, reason: null };
    if (hasNew) return { state: SWITCH_STATES.BEFORE_SWAP, reason: null };
    if (hasOld) return inspectBackupExists(paths);
    return { state: SWITCH_STATES.READY, reason: null };
  };

  const prepare = (db, { generation, startedAt }) => {
    const handle = openDatabase(switchPaths(db).fresh);
    try {
      const meta = createMetaStore({ db: handle });
      meta.setIfAbsent(GENERATION_KEY, generation);
      meta.setIfAbsent(STARTED_KEY, String(startedAt));
    } finally {
      handle.close();
    }
  };

  const exists = (path) => {
    if (fs.existsSync(path)) throw Object.assign(new Error(`${path} already exists; it is never overwritten.`), { code: 'EEXIST' });
  };

  const verifyBackup = (db, backupPath) => verifyBackupFile({ fs, openDatabase }, db, backupPath);

  // Copy to <db>.old.tmp, verify, then rename: an interrupted copy never looks like a finished backup.
  const copyAtomically = (paths) => {
    exists(paths.backup);
    fs.copyFileSync(paths.db, paths.partial, fs.constants.COPYFILE_EXCL);
    verifyBackup(paths.db, paths.partial);
    exists(paths.backup);
    fs.renameSync(paths.partial, paths.backup);
  };

  const linkOrCopy = (paths) => {
    try {
      fs.linkSync(paths.db, paths.backup);
    } catch (error) {
      if (!LINK_UNSUPPORTED.has(error.code)) throw error;
      logger.info(`Hard links are not available (${error.code}); copying the database instead.`);
      copyAtomically(paths);
    }
  };

  const backup = (db) => {
    const paths = switchPaths(db);
    linkOrCopy(paths);
    verifyBackup(paths.db, paths.backup);
    return paths.backup;
  };

  const swap = (db) => {
    const paths = switchPaths(db);
    fs.renameSync(paths.fresh, paths.db);
  };

  return { inspect, prepare, backup, swap, verifyBackup };
};
