// Everything an applied re-import needs after the long history read is checked before it, so a
// stopped Chroma or a bad embedding key fails in seconds instead of after the whole channel was fetched.
import path from 'node:path';
import { withTimeout } from '../util/withTimeout.js';

const PROBE_TEXT = 're-import preflight';
const HEADER = 'Preflight failed; nothing was fetched or changed:';

const timed = ({ clock }, promise, { ms, label }) =>
  withTimeout(promise, { ms, label, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

const checkChroma = async (ctx) => {
  const { port, connectTimeoutMs } = ctx.config.chroma;
  const client = new ctx.vendor.ChromaClient({ port });
  await timed(ctx, client.heartbeat(), { ms: connectTimeoutMs, label: 'heartbeat' });
};

const checkEmbedding = async (ctx) => {
  const { apiKeyEnvVar, modelName, dimensions } = ctx.config.embedding;
  const embedder = new ctx.vendor.OpenAIEmbeddingFunction({ apiKeyEnvVar, modelName, dimensions });
  const [vector] = await timed(ctx, embedder.generate([PROBE_TEXT]), { ms: ctx.config.chroma.timeoutMs, label: 'embedding request' });
  if (vector?.length !== dimensions) throw new Error(`expected ${dimensions} dimensions, got ${vector?.length}`);
};

const checkDirectory = async ({ fs, dbPath }) => {
  fs.accessSync(path.dirname(path.resolve(dbPath)), fs.constants.R_OK | fs.constants.W_OK);
};

const checks = (ctx) => [
  { name: `Chroma on port ${ctx.config.chroma.port}`, run: checkChroma },
  { name: `Embedding API (${ctx.config.embedding.apiKeyEnvVar})`, run: checkEmbedding },
  { name: `Database directory ${path.dirname(path.resolve(ctx.dbPath))}`, run: checkDirectory },
];

const failureOf = async (ctx, { name, run }) => {
  try {
    await run(ctx);
    return null;
  } catch (error) {
    return `${name}: ${error.message}`;
  }
};

export const preflight = async (ctx) => {
  const results = await Promise.all(checks(ctx).map((check) => failureOf(ctx, check)));
  const failures = results.filter(Boolean);
  if (failures.length > 0) throw new Error([HEADER, ...failures.map((line) => `  - ${line}`)].join('\n'));
};
