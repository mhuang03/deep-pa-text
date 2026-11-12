// Tracks in-flight handlers and intervals so shutdown can drain them, then closes the client and database.
const isShuttingDown = ({ state }) => state.shutdownPromise !== null;

const track = (ctx, handler, name = handler.name || 'handler') => async (...args) => {
  if (isShuttingDown(ctx)) return undefined;
  const id = ctx.state.nextId;
  ctx.state.nextId += 1;
  ctx.inFlight.set(id, name);
  try {
    return await handler(...args);
  } finally {
    ctx.inFlight.delete(id);
  }
};

// Time is counted in polls: a fake clock's sleep does not advance a real or mocked `now`.
const drain = async ({ inFlight, clock, logger, pollMs }, graceMs) => {
  for (let waited = 0; inFlight.size > 0 && waited < graceMs; waited += pollMs) {
    await clock.sleep(pollMs);
  }
  if (inFlight.size === 0) return;
  const names = [...inFlight.values()];
  logger.warn(`Shutdown grace period ran out; abandoning ${names.length} handler(s): ${names.join(', ')}`);
};

const attempt = async (logger, label, fn) => {
  try {
    await fn();
  } catch (error) {
    logger.error(`Shutdown: ${label} failed:`, error);
  }
};

const run = async (ctx, { reason, code, graceMs }) => {
  const { client, closeDatabase, clock, logger, exit, intervals } = ctx;
  if (reason) logger.info(`Shutting down: ${reason}`);
  intervals.splice(0).forEach((handle) => clock.clearInterval(handle));
  await drain(ctx, graceMs);
  await attempt(logger, 'closing the Discord client', () => client.destroy());
  await attempt(logger, 'closing the database', () => closeDatabase());
  exit(code);
};

const shutdown = (ctx, { reason, code = 0, graceMs = ctx.graceMs } = {}) => {
  ctx.state.shutdownPromise ??= run(ctx, { reason, code, graceMs });
  return ctx.state.shutdownPromise;
};

export const createLifecycle = ({ client, closeDatabase, clock, logger, exit, config }) => {
  const ctx = {
    client, closeDatabase, clock, logger, exit,
    graceMs: config.lifecycle.graceMs,
    pollMs: config.lifecycle.pollMs,
    inFlight: new Map(),
    intervals: [],
    state: { shutdownPromise: null, nextId: 0 },
  };
  return {
    track: (handler, name) => track(ctx, handler, name),
    every: (fn, ms) => {
      ctx.intervals.push(clock.setInterval(fn, ms));
    },
    shutdown: (options) => shutdown(ctx, options),
    isShuttingDown: () => isShuttingDown(ctx),
  };
};
