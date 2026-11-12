import { loadEnvFile } from 'node:process';
import { loadConfig } from './config.js';
import { loadData } from './userData/loadData.js';
import { buildContainer } from './container.js';
import { createVendor } from './vendor.js';

const main = async () => {
  loadEnvFile('.env');
  const config = loadConfig(process.env);
  const data = loadData(config.storage);
  const container = buildContainer({ config, vendor: createVendor(), data });
  await container.vectorStore.connect();
  await container.bot.start();
};

try {
  await main();
} catch (error) {
  console.error('Failed to start:', error);
  process.exitCode = 1;
}
