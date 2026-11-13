import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { loadEnvIfPresent } from '../src/config/env.js';
import { assertRequired } from '../src/config/requirements.js';
import { isConfigError } from '../src/config/errors.js';
import { formatTimestamp } from '../src/logger.js';
import { openDatabase } from '../src/storage/database.js';
import { createInspector } from '../src/storage/inspector.js';

const LIMIT = 10;

const noTable = (table) => `(no ${table} table yet)`;

const printSection = (config, { title, result, describe }) => {
  console.log(`${title}:`);
  if (result.missing) {
    console.log(noTable(result.missing));
    return;
  }
  result.rows.forEach((row) => {
    const when = formatTimestamp(row.timestamp, config.logging);
    console.log(`[${when}] ${row.author}: ${row.content} (${describe(row)})`);
  });
};

const printConversations = (config, result) => {
  console.log('Latest conversations:');
  if (result.missing) {
    console.log(noTable(result.missing));
    return;
  }
  result.rows.forEach((row) => {
    const when = formatTimestamp(row.timestamp, config.logging);
    console.log(`[${when}] ${row.topic} (${row.personas.join(', ')}; ${row.delivered}/${row.planned} turns delivered)`);
  });
};

const sectionsOf = (inspector) => [
  { title: 'Latest messages', result: inspector.latestRaw(LIMIT), describe: (m) => `reference: ${m.reference}` },
  {
    title: 'Latest filtered messages', result: inspector.latestFiltered(LIMIT),
    describe: (m) => `has_gif: ${m.has_gif}, reference: ${m.reference}`,
  },
  {
    title: 'Latest filtered messages with reference', result: inspector.latestWithReference(LIMIT),
    describe: (m) => `references: ${m.reference_content}`,
  },
  {
    title: 'Latest filtered messages with gif', result: inspector.latestWithGif(LIMIT),
    describe: (m) => `has_gif: ${m.has_gif}`,
  },
  { title: 'Latest bot messages', result: inspector.latestBot(LIMIT), describe: (m) => `reference: ${m.reference}` },
];

// Opens the file directly and read-only so nothing is created, migrated or copied.
const run = (config) => {
  const { databasePath, busyTimeoutMs } = config.storage;
  if (!fs.existsSync(databasePath)) throw new Error(`No database at ${databasePath}`);
  const db = openDatabase(databasePath, { readOnly: true, busyTimeoutMs });
  try {
    const inspector = createInspector({ db });
    sectionsOf(inspector).forEach((section) => printSection(config, section));
    printConversations(config, inspector.latestConversations(LIMIT));
  } finally {
    db.close();
  }
};

try {
  loadEnvIfPresent();
  const config = loadConfig(process.env);
  assertRequired(config, process.env, 'inspect');
  run(config);
} catch (error) {
  console.error(isConfigError(error) ? error.message : `Inspect failed: ${error.message}`);
  process.exitCode = 1;
}
