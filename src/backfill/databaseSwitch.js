// The only module that moves database files. Nothing is deleted or overwritten: the old database
// is hard-linked (or copied) to <db>.old, and the new one replaces it by an atomic rename.
const NEW_SUFFIX = '.new';
const OLD_SUFFIX = '.old';
const JOURNAL_SUFFIXES = ['-journal', '-wal', '-shm'];
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EXDEV']);
const STARTED_KEY = 'reimport_started_at';
const COMPLETED_KEY = 'reimport_completed_at';
const GENERATION_KEY = 'chroma_generation';
const TABLE_QUERY = "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?";

export const SWITCH_STATES = Object.freeze({
  READY: 'ready',
  BEFORE_BACKUP: 'interrupted-before-backup',
  BEFORE_SWAP: 'interrupted-before-swap',
  IN_PROGRESS: 'in-progress',
  BLOCKED: 'blocked',
});

export const switchPaths = (db) => ({
  db, fresh: `${db}${NEW_SUFFIX}`, backup: `${db}${OLD_SUFFIX}`, journals: JOURNAL_SUFFIXES.map((s) => `${db}${s}`),
});

const hasTable = (handle, name) => handle.prepare(TABLE_QUERY).get(name) !== undefined;

export const createDatabaseSwitch = ({ fs, openDatabase, createMetaStore, logger }) => {
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
    const journal = paths.journals.find((file) => fs.existsSync(file));
    if (journal) {
      return blocked(`${journal} exists, so the database may be in use or damaged. Stop the bot; if the file stays, move it away.`);
    }
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

  const linkOrCopy = (paths) => {
    try {
      fs.linkSync(paths.db, paths.backup);
    } catch (error) {
      if (!LINK_UNSUPPORTED.has(error.code)) throw error;
      logger.info(`Hard links are not available (${error.code}); copying the database instead.`);
      fs.copyFileSync(paths.db, paths.backup, fs.constants.COPYFILE_EXCL);
    }
  };

  const verifyBackup = (path) => {
    const handle = openDatabase(path, { readOnly: true });
    try {
      if (!hasTable(handle, 'messages')) throw new Error(`The backup ${path} has no messages table; it was not trusted.`);
    } finally {
      handle.close();
    }
  };

  const backup = (db) => {
    const paths = switchPaths(db);
    linkOrCopy(paths);
    verifyBackup(paths.backup);
    return paths.backup;
  };

  const swap = (db) => {
    const paths = switchPaths(db);
    fs.renameSync(paths.fresh, paths.db);
  };

  return { inspect, prepare, backup, swap };
};
