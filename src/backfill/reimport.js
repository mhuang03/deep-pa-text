import { createChannelHistory } from '../discord/channelHistory.js';
import { createWebhookProvider } from '../discord/webhooks.js';
import { loginAndWait } from '../discord/login.js';
import { createMessageFilter } from '../corpus/messageFilter.js';
import { createHistoryReader } from './historyReader.js';
import { createArchiveReader } from './archiveReader.js';
import { createReimportPlan } from './reimportPlan.js';
import { compareArchives } from './reimportComparison.js';
import { SWITCH_STATES, switchPaths } from './databaseSwitch.js';

const GENERATION_PREFIX = 'g';
const NON_DIGITS = /\D/g;
const TIMESTAMP_DIGITS = 14;
const RESUMABLE = [SWITCH_STATES.BEFORE_SWAP, SWITCH_STATES.IN_PROGRESS];

export const buildGeneration = (now) =>
  `${GENERATION_PREFIX}${new Date(now).toISOString().replace(NON_DIGITS, '').slice(0, TIMESTAMP_DIGITS)}`;

const refusal = ({ state, reason }) => {
  if (state === SWITCH_STATES.BLOCKED) return reason;
  if (state === SWITCH_STATES.BEFORE_BACKUP) {
    return 'A previous re-import stopped before the backup was made. Move the .new file next to the database away and run again; the database itself is untouched.';
  }
  return 'A previous re-import was interrupted. Run again with --resume to finish it.';
};

const assertRunnable = (status, resume) => {
  if (!resume) {
    if (status.state !== SWITCH_STATES.READY) throw new Error(refusal(status));
    return;
  }
  if (status.state === SWITCH_STATES.READY) throw new Error('Nothing to resume: no re-import was started.');
  if (status.state === SWITCH_STATES.BLOCKED) throw new Error(`Nothing to resume. ${status.reason}`);
  if (!RESUMABLE.includes(status.state)) throw new Error(refusal(status));
};

const verificationFailure = (error, db) => new Error(
  `${error.message} The original database is intact. Move ${db}.old away and run again without --resume `
  + `(move ${db}.new away too).`,
);

export const createReimporter = ({
  config, vendor, data, clock, logger, fs, buildContainer, createDiscordClient, databaseSwitch, openDatabase,
}) => {
  const dbPath = config.storage.databasePath;
  const paths = switchPaths(dbPath);

  const connect = async () => {
    const client = createDiscordClient(vendor.Client, { cacheMessages: false });
    try {
      await loginAndWait(client, config.discord.token);
      return { client, channel: await client.channels.fetch(config.discord.channelId) };
    } catch (error) {
      await client.destroy();
      throw error;
    }
  };

  const readHistory = (channel) => createHistoryReader({
    channelHistory: createChannelHistory({ logger }), config, clock, logger,
  }).readAll(channel);

  const withArchive = async (path, fn) => {
    if (!fs.existsSync(path)) throw new Error(`Expected the previous database at ${path}, but it does not exist.`);
    const handle = openDatabase(path, { readOnly: true, busyTimeoutMs: config.storage.busyTimeoutMs });
    try {
      return await fn(createArchiveReader({ db: handle }));
    } finally {
      handle.close();
    }
  };

  const classify = ({ client, channel, messages, archive }) => createReimportPlan({
    messageFilter: createMessageFilter({ users: data.users, pingCache: data.pingCache, config }),
    webhooks: createWebhookProvider({ getBotUserId: () => client.user?.id, config }),
    getBotUserId: () => client.user?.id,
    logger,
  }).plan(messages, { channel, archive });

  // A backup that is not a complete copy of the database must never let the fresh database replace it.
  const verifyBeforeSwap = (status) => {
    if (status.state !== SWITCH_STATES.BEFORE_SWAP) return;
    try {
      databaseSwitch.verifyBackup(dbPath, paths.backup);
    } catch (error) {
      throw verificationFailure(error, dbPath);
    }
  };

  const switchDatabase = (status, resume) => {
    if (resume) {
      verifyBeforeSwap(status);
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

  const importAll = async ({ container, channel, messages }) => {
    const result = await withArchive(paths.backup, async (archive) => {
      carryOver(archive, container.profileStore);
      return container.historyImporter.importMessages(messages, { channel, botMessageLookup: archive.botMessage });
    });
    const sync = await container.vectorSync.run();
    container.metaStore.setIfAbsent('reimport_completed_at', String(clock.now()));
    return { result, sync };
  };

  const compare = (container) => withArchive(paths.backup, (oldArchive) => compareArchives({
    oldArchive, newArchive: createArchiveReader({ db: container.db }), messageStore: container.messageStore,
  }));

  const toImported = ({ insertedRaw, kept, botMessages }) => ({
    insertedRaw,
    kept,
    botMessages: botMessages.imported,
    unattributedBotMessages: botMessages.unattributed,
    skippedEmptyBotMessages: botMessages.skippedEmpty,
  });

  const apply = async ({ status, resume, session, planned }) => {
    const created = switchDatabase(status, resume);
    const container = buildContainer({ config, vendor, data, clock, logger, client: session.client });
    try {
      await container.vectorStore.connect();
      const { result, sync } = await importAll({ container, ...session });
      const comparison = await compare(container);
      const generation = container.metaStore.get('chroma_generation') ?? created;
      return {
        ...planned, applied: true, generation, backupPath: paths.backup, imported: toImported(result), sync, comparison,
      };
    } finally {
      container.db.close();
    }
  };

  const unapplied = (status, planned, resume) => ({
    ...planned, applied: false, state: status.state, generation: resume ? null : buildGeneration(clock.now()),
    backupPath: null, imported: null, sync: null, comparison: null,
  });

  const run = async ({ yes = false, resume = false } = {}) => {
    const status = databaseSwitch.inspect(dbPath);
    assertRunnable(status, resume);
    if (resume) verifyBeforeSwap(status);
    const { client, channel } = await connect();
    try {
      const messages = await readHistory(channel);
      const source = resume ? paths.backup : dbPath;
      const planned = await withArchive(source, (archive) => classify({ client, channel, messages, archive }));
      if (!yes) return unapplied(status, planned, resume);
      return { state: status.state, ...(await apply({ status, resume, session: { client, channel, messages }, planned })) };
    } finally {
      await client.destroy();
    }
  };

  return { run };
};
