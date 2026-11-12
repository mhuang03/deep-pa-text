const NEW_SUFFIX = '.new';
const OLD_SUFFIX = '.old';
const PARTIAL_SUFFIX = '.old.tmp';
const JOURNAL_SUFFIXES = ['-journal', '-wal', '-shm'];

export const STARTED_KEY = 'reimport_started_at';
export const COMPLETED_KEY = 'reimport_completed_at';
export const GENERATION_KEY = 'chroma_generation';

export const SWITCH_STATES = Object.freeze({
  READY: 'ready',
  BEFORE_BACKUP: 'interrupted-before-backup',
  BEFORE_SWAP: 'interrupted-before-swap',
  IN_PROGRESS: 'in-progress',
  BLOCKED: 'blocked',
});

export const switchPaths = (db) => ({
  db,
  fresh: `${db}${NEW_SUFFIX}`,
  backup: `${db}${OLD_SUFFIX}`,
  partial: `${db}${PARTIAL_SUFFIX}`,
  journals: JOURNAL_SUFFIXES.map((s) => `${db}${s}`),
});
