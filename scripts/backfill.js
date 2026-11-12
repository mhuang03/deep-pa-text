import { loadConfig } from '../src/config.js';
import { loadEnvIfPresent } from '../src/config/env.js';
import { assertRequired } from '../src/config/requirements.js';
import { isConfigError } from '../src/config/errors.js';
import { loadData } from '../src/userData/loadData.js';
import { secretsOf } from '../src/config/secrets.js';
import { createLogger } from '../src/logger.js';
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

const run = async (options, config, logger) => {
  const container = buildContainer({
    config, vendor: createVendor(), data: loadData(config.storage), cacheMessages: false, logger,
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

const reportFailure = (error, logger) => {
  logger.error(isConfigError(error) ? error.message : `Backfill failed: ${error.message}`);
  if (error.isVectorError) logger.error(VECTOR_HINT);
  process.exitCode = 1;
};

const main = async (options) => {
  loadEnvIfPresent();
  const config = loadConfig(process.env);
  assertRequired(config, process.env, 'backfill');
  const logger = createLogger(console, { secrets: secretsOf(config) });
  try {
    await run(options, config, logger);
  } catch (error) {
    reportFailure(error, logger);
  }
};

const options = parseOrExit();
try {
  await main(options);
} catch (error) {
  // Nothing is configured yet, so there is no secret to redact.
  reportFailure(error, createLogger(console));
}
