// The numbered steps of a re-import (spec 26), each a function of the run's dependencies `ctx`.
import { createChannelHistory } from '../discord/channelHistory.js';
import { createWebhookProvider } from '../discord/webhooks.js';
import { loginAndWait } from '../discord/login.js';
import { createMessageFilter } from '../corpus/messageFilter.js';
import { createHistoryReader } from './historyReader.js';
import { createArchiveReader } from './archiveReader.js';
import { createReimportPlan } from './reimportPlan.js';
import { compareArchives } from './reimportComparison.js';
import { SWITCH_STATES } from './databaseSwitch.js';
import { buildGeneration, verificationFailure } from './reimportGuards.js';

export const connect = async ({ config, vendor, createDiscordClient }) => {
  const client = createDiscordClient(vendor.Client, { cacheMessages: false });
  try {
    await loginAndWait(client, config.discord.token);
    return { client, channel: await client.channels.fetch(config.discord.channelId) };
  } catch (error) {
    await client.destroy();
    throw error;
  }
};

export const readHistory = ({ config, clock, logger }, channel) => createHistoryReader({
  channelHistory: createChannelHistory({ logger }), config, clock, logger,
}).readAll(channel);

export const withArchive = async ({ fs, config, openDatabase }, path, fn) => {
  if (!fs.existsSync(path)) throw new Error(`Expected the previous database at ${path}, but it does not exist.`);
  const handle = openDatabase(path, { readOnly: true, busyTimeoutMs: config.storage.busyTimeoutMs });
  try {
    return await fn(createArchiveReader({ db: handle }));
  } finally {
    handle.close();
  }
};

export const classify = ({ config, data, logger }, { client, channel, messages, archive }) => createReimportPlan({
  messageFilter: createMessageFilter({ users: data.users, pingCache: data.pingCache, config }),
  webhooks: createWebhookProvider({ getBotUserId: () => client.user?.id, config }),
  getBotUserId: () => client.user?.id,
  logger,
}).plan(messages, { channel, archive });

// A backup that is not a complete copy of the database must never let the fresh database replace it.
export const verifyBeforeSwap = ({ databaseSwitch, dbPath, paths }, status) => {
  if (status.state !== SWITCH_STATES.BEFORE_SWAP) return;
  try {
    databaseSwitch.verifyBackup(dbPath, paths.backup);
  } catch (error) {
    throw verificationFailure(error, dbPath);
  }
};

export const switchDatabase = (ctx, status, resume) => {
  const { databaseSwitch, dbPath, clock } = ctx;
  if (resume) {
    verifyBeforeSwap(ctx, status);
    if (status.state === SWITCH_STATES.BEFORE_SWAP) databaseSwitch.swap(dbPath);
    return null;
  }
  const generation = buildGeneration(clock.now());
  databaseSwitch.prepare(dbPath, { generation, startedAt: clock.now() });
  databaseSwitch.backup(dbPath);
  databaseSwitch.swap(dbPath);
  return generation;
};

const carryOver = (archive, profileStore) => archive.profiles().forEach((row) => profileStore.record({
  username: row.username,
  userId: row.user_id,
  displayName: row.display_name,
  avatarURL: row.avatar_url,
  observedAt: row.observed_at,
}));

export const importAll = async (ctx, { container, channel, messages }) => {
  const result = await withArchive(ctx, ctx.paths.backup, async (archive) => {
    carryOver(archive, container.profileStore);
    return container.historyImporter.importMessages(messages, { channel, botMessageLookup: archive.botMessage });
  });
  const sync = await container.vectorSync.run();
  container.metaStore.setIfAbsent('reimport_completed_at', String(ctx.clock.now()));
  return { result, sync };
};

export const compare = (ctx, container) => withArchive(ctx, ctx.paths.backup, (oldArchive) => compareArchives({
  oldArchive,
  newArchive: createArchiveReader({ db: container.db }),
  messageStore: container.messageStore,
  pageSize: ctx.config.backfill.comparisonPageSize,
}));

export const toImported = ({ insertedRaw, kept, botMessages }) => ({
  insertedRaw,
  kept,
  botMessages: botMessages.imported,
  unattributedBotMessages: botMessages.unattributed,
  skippedEmptyBotMessages: botMessages.skippedEmpty,
});
