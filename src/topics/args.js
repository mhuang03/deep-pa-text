import { parseArgs } from 'node:util';

export const TOPICS_USAGE = `Usage: npm run topics -- [options]

  (no options)          build the topic bank: cluster stored embeddings, label each cluster, store the topics
  --dry-run             cluster and print a preview; no LLM call, nothing written
  --max-messages <n>    sample at most n messages (integer >= 1); overrides topics.maxMessages
  --list                print the current topic bank
  --hide <id>           hide one topic (it stays in the database)`;

const OPTIONS = {
  'dry-run': { type: 'boolean' },
  'max-messages': { type: 'string' },
  list: { type: 'boolean' },
  hide: { type: 'string' },
};

const DIGITS = /^\d+$/;

const usageError = (message) => Object.assign(new Error(message), { isUsageError: true });

const parsePositive = (name, raw) => {
  if (raw === undefined) return null;
  const value = DIGITS.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) throw usageError(`--${name} must be an integer of at least 1, got "${raw}"`);
  return value;
};

const readValues = (argv) => {
  try {
    return parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw usageError(error.message);
  }
};

export const parseTopicsArgs = (argv) => {
  const values = readValues(argv);
  const options = {
    dryRun: Boolean(values['dry-run']),
    maxMessages: parsePositive('max-messages', values['max-messages']),
    list: Boolean(values.list),
    hide: parsePositive('hide', values.hide),
  };
  const building = options.dryRun || options.maxMessages !== null;
  if (options.list && options.hide !== null) throw usageError('--list and --hide cannot be combined');
  if ((options.list || options.hide !== null) && building) {
    throw usageError('--list and --hide cannot be combined with --dry-run or --max-messages');
  }
  return options;
};
