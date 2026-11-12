import { loadConfig } from '../src/config.js';
import { formatTimestamp } from '../src/logger.js';
import { openDatabase } from '../src/storage/database.js';
import { createMessageStore } from '../src/storage/messageStore.js';

const LIMIT = 10;

const config = loadConfig({});
const store = createMessageStore({
  db: openDatabase(config.storage.databasePath, { readOnly: true }),
  config,
});

const print = (title, rows, describe) => {
  console.log(`${title}:`);
  rows.forEach((row) => {
    const when = formatTimestamp(row.timestamp, config.logging);
    console.log(`[${when}] ${row.author}: ${row.content} (${describe(row)})`);
  });
};

print('Latest messages', store.latestRaw(LIMIT), (m) => `reference: ${m.reference}`);
print('Latest filtered messages', store.latestFiltered(LIMIT),
  (m) => `has_gif: ${m.has_gif}, reference: ${m.reference}`);
print('Latest filtered messages with reference', store.latestWithReference(LIMIT),
  (m) => `references: ${m.reference_content}`);
print('Latest filtered messages with gif', store.latestWithGif(LIMIT), (m) => `has_gif: ${m.has_gif}`);
