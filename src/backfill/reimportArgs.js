import { parseArgs } from 'node:util';

export const REIMPORT_USAGE = `Usage: npm run reimport -- [options]

  --yes      apply the re-import (without it only a report is printed and nothing is changed)
  --resume   continue an interrupted re-import`;

const OPTIONS = { yes: { type: 'boolean' }, resume: { type: 'boolean' } };

const usageError = (message) => Object.assign(new Error(message), { isUsageError: true });

export const parseReimportArgs = (argv) => {
  try {
    const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
    return { yes: Boolean(values.yes), resume: Boolean(values.resume) };
  } catch (error) {
    throw usageError(error.message);
  }
};
