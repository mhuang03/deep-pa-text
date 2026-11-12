import { loadConfig } from './config.js';
import { loadEnvIfPresent } from './config/env.js';
import { assertRequired, buildGifKeyWarning } from './config/requirements.js';
import { isConfigError } from './config/errors.js';
import { loadData } from './userData/loadData.js';
import { buildContainer } from './container.js';
import { createVendor } from './vendor.js';

const main = async () => {
  loadEnvIfPresent();
  const config = loadConfig(process.env);
  assertRequired(config, process.env, 'bot');
  const data = loadData(config.storage);
  const container = buildContainer({ config, vendor: createVendor(), data });
  const gifWarning = buildGifKeyWarning(config);
  if (gifWarning) container.logger.warn(gifWarning);
  await container.vectorStore.connect();
  await container.bot.start();
};

try {
  await main();
} catch (error) {
  if (isConfigError(error)) console.error(error.message);
  else console.error('Failed to start:', error);
  process.exitCode = 1;
}
