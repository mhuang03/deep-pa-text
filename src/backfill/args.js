import { parseArgs } from 'node:util';

export const BACKFILL_USAGE = `Usage: npm run backfill -- [options]

  --dry-run          report what would be written; write nothing to SQLite or Chroma
  --skip-history     do not import from Discord (requires --sync-vectors)
  --sync-vectors     after importing, reconcile Chroma with SQLite
  --before <id>      import only messages older than this Discord message id (digits only)
  --limit <n>        fetch at most n messages from Discord, newest first (integer >= 1)`;

const OPTIONS = {
  'dry-run': { type: 'boolean' },
  'skip-history': { type: 'boolean' },
  'sync-vectors': { type: 'boolean' },
  before: { type: 'string' },
  limit: { type: 'string' },
};

const DIGITS = /^\d+$/;

const usageError = (message) => Object.assign(new Error(message), { isUsageError: true });

const parseLimit = (raw) => {
  if (raw === undefined) return Infinity;
  const limit = DIGITS.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1) throw usageError(`--limit must be an integer of at least 1, got "${raw}"`);
  return limit;
};

const parseBefore = (raw) => {
  if (raw === undefined) return null;
  if (!DIGITS.test(raw)) throw usageError(`--before must be a Discord message id (digits only), got "${raw}"`);
  return raw;
};

const readValues = (argv) => {
  try {
    return parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw usageError(error.message);
  }
};

export const parseBackfillArgs = (argv) => {
  const values = readValues(argv);
  const options = {
    dryRun: Boolean(values['dry-run']),
    skipHistory: Boolean(values['skip-history']),
    syncVectors: Boolean(values['sync-vectors']),
    before: parseBefore(values.before),
    limit: parseLimit(values.limit),
  };
  if (options.skipHistory && !options.syncVectors) throw usageError('--skip-history requires --sync-vectors');
  return options;
};
