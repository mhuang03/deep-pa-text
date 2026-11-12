// The only module that moves database files. Nothing is deleted or overwritten: the old database
// is hard-linked (or copied via <db>.old.tmp and an atomic rename) to <db>.old, and the new one replaces
// it by an atomic rename. A backup is verified against the original before every swap.
import { verifyBackupFile } from './backupVerifier.js';
import { inspectSwitch } from './switchInspect.js';
import { SWITCH_STATES, GENERATION_KEY, STARTED_KEY, switchPaths } from './switchState.js';

export { SWITCH_STATES, switchPaths } from './switchState.js';

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EXDEV']);

const assertAbsent = ({ fs }, path) => {
  if (fs.existsSync(path)) throw Object.assign(new Error(`${path} already exists; it is never overwritten.`), { code: 'EEXIST' });
};

const verifyBackup = ({ fs, openDatabase }, db, backupPath) =>
  verifyBackupFile({ fs, openDatabase }, db, backupPath);

// Copy to <db>.old.tmp, verify, then rename: an interrupted copy never looks like a finished backup.
const copyAtomically = (ctx, paths) => {
  const { fs } = ctx;
  assertAbsent(ctx, paths.backup);
  fs.copyFileSync(paths.db, paths.partial, fs.constants.COPYFILE_EXCL);
  verifyBackup(ctx, paths.db, paths.partial);
  assertAbsent(ctx, paths.backup);
  fs.renameSync(paths.partial, paths.backup);
};

const linkOrCopy = (ctx, paths) => {
  try {
    ctx.fs.linkSync(paths.db, paths.backup);
  } catch (error) {
    if (!LINK_UNSUPPORTED.has(error.code)) throw error;
    ctx.logger.info(`Hard links are not available (${error.code}); copying the database instead.`);
    copyAtomically(ctx, paths);
  }
};

const prepare = ({ openDatabase, createMetaStore }, db, { generation, startedAt }) => {
  const handle = openDatabase(switchPaths(db).fresh);
  try {
    const meta = createMetaStore({ db: handle });
    meta.setIfAbsent(GENERATION_KEY, generation);
    meta.setIfAbsent(STARTED_KEY, String(startedAt));
  } finally {
    handle.close();
  }
};

const backup = (ctx, db) => {
  const paths = switchPaths(db);
  linkOrCopy(ctx, paths);
  verifyBackup(ctx, paths.db, paths.backup);
  return paths.backup;
};

export const createDatabaseSwitch = ({ fs, openDatabase: open, createMetaStore, logger, busyTimeoutMs }) => {
  const openDatabase = (path, options = {}) => open(path, { ...options, busyTimeoutMs });
  const ctx = { fs, openDatabase, createMetaStore, logger };
  return {
    inspect: (db) => inspectSwitch(ctx, db),
    prepare: (db, options) => prepare(ctx, db, options),
    backup: (db) => backup(ctx, db),
    swap: (db) => {
      const paths = switchPaths(db);
      fs.renameSync(paths.fresh, paths.db);
    },
    verifyBackup: (db, backupPath) => verifyBackup(ctx, db, backupPath),
  };
};
