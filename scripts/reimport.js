import fs from 'node:fs';
import { loadEnvFile } from 'node:process';
import { loadConfig } from '../src/config.js';
import { loadData } from '../src/userData/loadData.js';
import { buildContainer, defaultClock } from '../src/container.js';
import { createVendor } from '../src/vendor.js';
import { createLogger } from '../src/logger.js';
import { openDatabase } from '../src/storage/database.js';
import { createMetaStore } from '../src/storage/metaStore.js';
import { createDiscordClient } from '../src/discord/client.js';
import { createDatabaseSwitch } from '../src/backfill/databaseSwitch.js';
import { createReimporter } from '../src/backfill/reimport.js';
import { parseReimportArgs, REIMPORT_USAGE } from '../src/backfill/reimportArgs.js';
import { formatReport } from '../src/backfill/reimportReport.js';

const USAGE_EXIT_CODE = 2;
const WARNING = 'STOP THE BOT BEFORE CONTINUING. A running bot keeps the old database file open and would write into the backup.\n'
  + 'This script cannot detect a running bot.';

const parseOrExit = () => {
  try {
    return parseReimportArgs(process.argv.slice(2));
  } catch (error) {
    if (!error.isUsageError) throw error;
    console.error(`${error.message}\n\n${REIMPORT_USAGE}`);
    process.exit(USAGE_EXIT_CODE);
  }
};

const main = async (options) => {
  console.log(`${WARNING}\n`);
  loadEnvFile('.env');
  const config = loadConfig(process.env);
  const logger = createLogger();
  const reimporter = createReimporter({
    config,
    vendor: createVendor(),
    data: loadData(config.storage),
    clock: defaultClock(),
    logger,
    fs,
    buildContainer,
    createDiscordClient,
    databaseSwitch: createDatabaseSwitch({ fs, openDatabase, createMetaStore, logger }),
    openDatabase,
  });
  formatReport(await reimporter.run(options)).forEach((line) => console.log(line));
};

const options = parseOrExit();
try {
  await main(options);
} catch (error) {
  console.error(`Re-import failed: ${error.message}`);
  process.exitCode = 1;
}
