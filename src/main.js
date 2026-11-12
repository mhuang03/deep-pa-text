import { loadConfig } from './config.js';
import { loadEnvIfPresent } from './config/env.js';
import { assertRequired, buildGifKeyWarning } from './config/requirements.js';
import { isConfigError } from './config/errors.js';
import { loadData } from './userData/loadData.js';
import { secretsOf } from './config/secrets.js';
import { createLogger } from './logger.js';
import { buildContainer } from './container.js';
import { createVendor } from './vendor.js';
import { createStartup } from './bot/startup.js';
import { installProcessHooks } from './bot/processHooks.js';

const FAILURE_EXIT_CODE = 1;

const report = (error, logger) => {
  if (isConfigError(error)) logger.error(error.message);
  else logger.error('Failed to start:', error);
};

// Once the hooks are installed a failed start goes through shutdown, so the database is closed.
const start = async (container, config) => {
  installProcessHooks({ process, lifecycle: container.lifecycle, logger: container.logger });
  const gifWarning = buildGifKeyWarning(config);
  if (gifWarning) container.logger.warn(gifWarning);
  const { metaStore, vectorStore, bot } = container;
  try {
    await createStartup({ metaStore, vectorStore, bot, config }).run();
  } catch (error) {
    report(error, container.logger);
    await container.lifecycle.shutdown({ code: FAILURE_EXIT_CODE });
  }
};

const main = async () => {
  loadEnvIfPresent();
  const config = loadConfig(process.env);
  assertRequired(config, process.env, 'bot');
  const logger = createLogger(console, { secrets: secretsOf(config) });
  const data = loadData(config.storage);
  const exit = (code) => process.exit(code);
  const container = buildContainer({ config, vendor: createVendor(), data, exit, logger });
  await start(container, config);
};

try {
  await main();
} catch (error) {
  // No configuration exists yet, so there is no secret this logger could need to redact.
  report(error, createLogger(console));
  process.exitCode = FAILURE_EXIT_CODE;
}
