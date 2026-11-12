import { loadEnvFile } from 'node:process';
import { loadConfig } from '../src/config.js';
import { loadData } from '../src/userData/loadData.js';
import { buildContainer } from '../src/container.js';
import { createVendor } from '../src/vendor.js';
import { loginAndWait } from '../src/discord/login.js';
import { parseBackfillArgs, BACKFILL_USAGE } from '../src/backfill/args.js';

const USAGE_EXIT_CODE = 2;
const VECTOR_HINT = 'The vector store failed; the SQLite rows are safe. Re-run with --sync-vectors to repair it.';

const parseOrExit = () => {
  try {
    return parseBackfillArgs(process.argv.slice(2));
  } catch (error) {
    if (!error.isUsageError) throw error;
    console.error(`${error.message}\n\n${BACKFILL_USAGE}`);
    process.exit(USAGE_EXIT_CODE);
  }
};

// No handlers are registered (bot.start() is never called), so the script cannot reply to anything.
const importHistory = async (container, options, config) => {
  const { client, historyImporter } = container;
  await loginAndWait(client, config.discord.token);
  const channel = await client.channels.fetch(config.discord.channelId);
  return historyImporter.run({ channel, ...options });
};

const syncVectors = async ({ vectorSync }, { dryRun }) => {
  const result = await vectorSync.run({ dryRun });
  if (dryRun) console.log('Dry run: the sync cannot see rows the import would have added.');
  return result;
};

const main = async (options) => {
  loadEnvFile('.env');
  const config = loadConfig(process.env);
  const container = buildContainer({
    config, vendor: createVendor(), data: loadData(config.storage), cacheMessages: false,
  });
  try {
    await container.vectorStore.connect();
    const report = {};
    if (!options.skipHistory) report.import = await importHistory(container, options, config);
    if (options.syncVectors) report.vectorSync = await syncVectors(container, options);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await container.client.destroy();
  }
};

const options = parseOrExit();
try {
  await main(options);
} catch (error) {
  console.error(`Backfill failed: ${error.message}`);
  if (error.isVectorError) console.error(VECTOR_HINT);
  process.exitCode = 1;
}
