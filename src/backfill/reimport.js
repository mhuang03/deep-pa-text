import { switchPaths } from './databaseSwitch.js';
import { assertRunnable, buildGeneration } from './reimportGuards.js';
import * as step from './reimportSteps.js';

export { buildGeneration } from './reimportGuards.js';

const apply = async (ctx, { status, resume, session, planned }) => {
  const { config, vendor, data, clock, logger, buildContainer, paths } = ctx;
  const created = step.switchDatabase(ctx, status, resume);
  const container = buildContainer({ config, vendor, data, clock, logger, client: session.client });
  try {
    await container.vectorStore.connect();
    const { result, sync } = await step.importAll(ctx, { container, ...session });
    const comparison = await step.compare(ctx, container);
    const generation = container.metaStore.get('chroma_generation') ?? created;
    return {
      ...planned, applied: true, generation, backupPath: paths.backup, imported: step.toImported(result), sync, comparison,
    };
  } finally {
    container.db.close();
  }
};

const unapplied = ({ clock }, { status, planned, resume }) => ({
  ...planned, applied: false, state: status.state, generation: resume ? null : buildGeneration(clock.now()),
  backupPath: null, imported: null, sync: null, comparison: null,
});

const run = async (ctx, { yes = false, resume = false } = {}) => {
  const { databaseSwitch, dbPath, paths } = ctx;
  const status = databaseSwitch.inspect(dbPath);
  assertRunnable(status, resume);
  if (resume) step.verifyBeforeSwap(ctx, status);
  const { client, channel } = await step.connect(ctx);
  try {
    const messages = await step.readHistory(ctx, channel);
    const source = resume ? paths.backup : dbPath;
    const planned = await step.withArchive(ctx, source, (archive) => step.classify(ctx, { client, channel, messages, archive }));
    if (!yes) return unapplied(ctx, { status, planned, resume });
    const applied = await apply(ctx, { status, resume, session: { client, channel, messages }, planned });
    return { state: status.state, ...applied };
  } finally {
    await client.destroy();
  }
};

export const createReimporter = (deps) => {
  const dbPath = deps.config.storage.databasePath;
  const ctx = { ...deps, dbPath, paths: switchPaths(dbPath) };
  return { run: (options) => run(ctx, options) };
};
