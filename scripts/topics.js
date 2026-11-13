import { loadConfig } from '../src/config.js';
import { loadEnvIfPresent } from '../src/config/env.js';
import { assertRequired } from '../src/config/requirements.js';
import { isConfigError } from '../src/config/errors.js';
import { loadData } from '../src/userData/loadData.js';
import { secretsOf } from '../src/config/secrets.js';
import { createLogger, formatTimestamp } from '../src/logger.js';
import { buildContainer } from '../src/container.js';
import { createVendor } from '../src/vendor.js';
import { openDatabase } from '../src/storage/database.js';
import { createTopicStore } from '../src/storage/topicStore.js';
import { parseTopicsArgs, TOPICS_USAGE } from '../src/topics/args.js';

const USAGE_EXIT_CODE = 2;

const parseOrExit = () => {
  try {
    return parseTopicsArgs(process.argv.slice(2));
  } catch (error) {
    if (!error.isUsageError) throw error;
    console.error(`${error.message}\n\n${TOPICS_USAGE}`);
    process.exit(USAGE_EXIT_CODE);
  }
};

const printTopic = (topic, config) => {
  const authors = topic.authors.map(({ author, share }) => `${author} ${Math.round(share * 100)}%`).join(', ');
  const date = formatTimestamp(topic.medianTimestamp, config.logging);
  console.log(`#${topic.id} ${topic.label} (${topic.size} messages, ${date})`);
  console.log(`    authors: ${authors}`);
  console.log(`    ${topic.summary}`);
};

const printBank = (store, config) => {
  const build = store.currentBuild();
  const topics = store.currentTopics();
  console.log(build ? `Topic bank, build ${build.buildId}: ${topics.length} topics` : 'Topic bank is empty: no completed build.');
  topics.forEach((topic) => printTopic(topic, config));
};

// The bank commands only touch the topic tables, so they need neither Chroma nor the LLM.
const withBank = (config, action) => {
  const { databasePath, busyTimeoutMs } = config.storage;
  const db = openDatabase(databasePath, { busyTimeoutMs });
  try {
    action(createTopicStore({ db }));
  } finally {
    db.close();
  }
};

const hide = (store, id) => {
  const found = store.hide(id, Date.now());
  console.log(found ? `Topic ${id} is hidden.` : `Topic ${id} was not found or is already hidden.`);
};

const build = async (options, config, logger) => {
  const container = buildContainer({
    config, vendor: createVendor(), data: loadData(config.storage), cacheMessages: false, logger,
  });
  try {
    await container.vectorStore.connect();
    const report = await container.topicBuilder.run({
      dryRun: options.dryRun, ...(options.maxMessages !== null && { maxMessages: options.maxMessages }),
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await container.client.destroy();
    container.db.close();
  }
};

const purposeOf = (options) => {
  if (options.list || options.hide !== null) return 'topics-bank';
  return options.dryRun ? 'topics-dry-run' : 'topics';
};

const main = async (options) => {
  loadEnvIfPresent();
  const config = loadConfig(process.env);
  assertRequired(config, process.env, purposeOf(options));
  const logger = createLogger(console, { secrets: secretsOf(config) });
  if (options.list) return withBank(config, (store) => printBank(store, config));
  if (options.hide !== null) return withBank(config, (store) => hide(store, options.hide));
  return build(options, config, logger);
};

const reportFailure = (error) => {
  console.error(isConfigError(error) ? error.message : `Topics failed: ${error.message}`);
  process.exitCode = 1;
};

const options = parseOrExit();
try {
  await main(options);
} catch (error) {
  reportFailure(error);
}
