// Tracks vectors that live ingest could not write and repairs them from SQLite, which is the source of truth.
export const createVectorHealth = ({ vectorSync, clock, config, logger }) => {
  const { repairIntervalMs, repairWindowMs } = config.vector;
  let debt = 0;
  let syncing = false;
  let lastWarningAt = null;

  const warnOnce = (error) => {
    const at = clock.now();
    if (lastWarningAt !== null && at - lastWarningAt < repairIntervalMs) return;
    lastWarningAt = at;
    logger.warn(`Vectors are missing (${error?.message}); they will be repaired automatically.`);
  };

  const noteFailure = (error) => {
    debt += 1;
    warnOnce(error);
  };

  const summary = (totals) =>
    `Vector repair checked ${totals.checked} rows: added ${totals.addedMessages} messages and `
    + `${totals.addedReplies} replies, filled ${totals.filledMetadata}.`;

  const sync = async ({ sinceMs, onFailure }) => {
    if (syncing) return;
    syncing = true;
    const snapshot = debt;
    try {
      const totals = await vectorSync.run({ sinceMs, quiet: true });
      if (debt === snapshot) debt = 0;
      logger.info(summary(totals));
    } catch (error) {
      logger.warn(`Vector repair failed; it will be retried: ${error?.message}`);
      onFailure(error);
    } finally {
      syncing = false;
    }
  };

  const repair = async () => {
    if (debt === 0) return;
    await sync({ sinceMs: clock.now() - repairWindowMs, onFailure: () => {} });
  };

  // A failed startup repair leaves debt, so the interval retries it.
  const startupRepair = () => sync({
    sinceMs: clock.now() - repairWindowMs,
    onFailure: noteFailure,
  });

  return { noteFailure, repair, startupRepair };
};
