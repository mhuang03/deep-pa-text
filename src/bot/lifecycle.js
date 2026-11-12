// Tracks in-flight handlers and intervals so shutdown can drain them, then closes the client and database.
export const createLifecycle = ({ client, closeDatabase, clock, logger, exit, config }) => {
  const { graceMs: defaultGraceMs, pollMs } = config.lifecycle;
  const inFlight = new Map();
  const intervals = [];
  let shutdownPromise = null;
  let nextId = 0;

  const isShuttingDown = () => shutdownPromise !== null;

  const track = (handler, name = handler.name || 'handler') => async (...args) => {
    if (isShuttingDown()) return undefined;
    const id = nextId++;
    inFlight.set(id, name);
    try {
      return await handler(...args);
    } finally {
      inFlight.delete(id);
    }
  };

  const every = (fn, ms) => {
    intervals.push(clock.setInterval(fn, ms));
  };

  // Time is counted in polls: a fake clock's sleep does not advance a real or mocked `now`.
  const drain = async (graceMs) => {
    for (let waited = 0; inFlight.size > 0 && waited < graceMs; waited += pollMs) {
      await clock.sleep(pollMs);
    }
    if (inFlight.size === 0) return;
    const names = [...inFlight.values()];
    logger.warn(`Shutdown grace period ran out; abandoning ${names.length} handler(s): ${names.join(', ')}`);
  };

  const attempt = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      logger.error(`Shutdown: ${label} failed:`, error);
    }
  };

  const run = async ({ reason, code, graceMs }) => {
    if (reason) logger.info(`Shutting down: ${reason}`);
    intervals.splice(0).forEach((handle) => clock.clearInterval(handle));
    await drain(graceMs);
    await attempt('closing the Discord client', () => client.destroy());
    await attempt('closing the database', () => closeDatabase());
    exit(code);
  };

  const shutdown = ({ reason, code = 0, graceMs = defaultGraceMs } = {}) => {
    shutdownPromise ??= run({ reason, code, graceMs });
    return shutdownPromise;
  };

  return { track, every, shutdown, isShuttingDown };
};
