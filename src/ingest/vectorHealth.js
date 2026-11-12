// Tracks vectors that live ingest could not write and repairs them from SQLite, which is the source of truth.
const warnOnce = ({ clock, config, logger, state }, error) => {
  const at = clock.now();
  if (state.lastWarningAt !== null && at - state.lastWarningAt < config.vector.repairIntervalMs) return;
  state.lastWarningAt = at;
  logger.warn(`Vectors are missing (${error?.message}); they will be repaired automatically.`);
};

const noteFailure = (ctx, error) => {
  ctx.state.debt += 1;
  warnOnce(ctx, error);
};

const summary = (totals) =>
  `Vector repair checked ${totals.checked} rows: added ${totals.addedMessages} messages and `
  + `${totals.addedReplies} replies, filled ${totals.filledMetadata}.`;

const sync = async ({ vectorSync, logger, state }, { sinceMs, onFailure }) => {
  if (state.syncing) return;
  state.syncing = true;
  const snapshot = state.debt;
  try {
    const totals = await vectorSync.run({ sinceMs, quiet: true });
    if (state.debt === snapshot) state.debt = 0;
    logger.info(summary(totals));
  } catch (error) {
    logger.warn(`Vector repair failed; it will be retried: ${error?.message}`);
    onFailure(error);
  } finally {
    state.syncing = false;
  }
};

const sinceOf = ({ clock, config }) => clock.now() - config.vector.repairWindowMs;

export const createVectorHealth = ({ vectorSync, clock, config, logger }) => {
  const ctx = { vectorSync, clock, config, logger, state: { debt: 0, syncing: false, lastWarningAt: null } };
  return {
    noteFailure: (error) => noteFailure(ctx, error),
    repair: async () => {
      if (ctx.state.debt === 0) return;
      await sync(ctx, { sinceMs: sinceOf(ctx), onFailure: () => {} });
    },
    // A failed startup repair leaves debt, so the interval retries it.
    startupRepair: () => sync(ctx, { sinceMs: sinceOf(ctx), onFailure: (error) => noteFailure(ctx, error) }),
  };
};
