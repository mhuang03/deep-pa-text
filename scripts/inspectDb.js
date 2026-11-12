import { loadConfig } from '../src/config.js';
import { formatTimestamp } from '../src/logger.js';
import { openDatabase } from '../src/storage/database.js';
import { createMessageStore } from '../src/storage/messageStore.js';
import { createBotMessageStore } from '../src/storage/botMessageStore.js';

const LIMIT = 10;
const BOT_TABLE = 'bot_messages';

const config = loadConfig({});
const db = openDatabase(config.storage.databasePath, { readOnly: true });
const store = createMessageStore({ db, config });
const NO_BOT_TABLE = '(no bot_messages table yet)';

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

// Read-only mode runs no migrations, so the table may not exist yet.
const hasBotTable = () =>
  db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(BOT_TABLE) !== undefined;

if (hasBotTable()) {
  const rows = createBotMessageStore({ db }).recent({ limit: LIMIT })
    .map((m) => ({ ...m, author: `${m.persona} [${m.trigger}]` }));
  print('Latest bot messages', rows, (m) => `reference: ${m.reference}`);
} else {
  console.log('Latest bot messages:');
  console.log(NO_BOT_TABLE);
}
