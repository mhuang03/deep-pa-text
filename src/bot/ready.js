// What happens once the gateway is ready: restore state, start the timers, catch up on missed messages.
export const createReady = ({
  client, config, handlers, lifecycle, startupTasks, vectorHealth, logger,
}) => {
  const { track, every } = lifecycle;
  let started = false;

  const revivePeriod = () =>
    config.revive.override ? config.revive.overrideCheckIntervalMs : config.revive.checkIntervalMs;

  // A failed step is logged and the next one still runs.
  const guarded = async (label, fn, level = 'error') => {
    try {
      return await fn();
    } catch (error) {
      logger[level](`Startup step "${label}" failed:`, error);
      return null;
    }
  };

  // The first refresh is not awaited: it must not delay ready. The handler catches its own errors.
  const startProfileRefresh = () => {
    const period = config.profiles.refreshIntervalMs;
    if (period === 0) return;
    const refresh = track(handlers.profileRefresh, 'profileRefresh');
    refresh();
    every(refresh, period);
  };

  const startIntervals = () => {
    every(track(handlers.reviveTick, 'reviveTick'), revivePeriod());
    startProfileRefresh();
    every(track(vectorHealth.repair, 'vectorRepair'), config.vector.repairIntervalMs);
  };

  // Not awaited: the repair can take long and must not delay ready. It never throws.
  const startupRepair = () => {
    track(vectorHealth.startupRepair, 'vectorStartupRepair')();
  };

  const catchUp = async () => {
    const channel = await client.channels.fetch(config.discord.channelId);
    return startupTasks.catchUp(channel);
  };

  const onReady = async () => {
    if (started) return;
    started = true;
    logger.info(`Logged in as ${client.user.tag}`);
    await guarded('restore state', () => startupTasks.restoreState());
    startIntervals();
    const result = await guarded('catch up', catchUp, 'warn');
    if (result === null) vectorHealth.noteFailure(new Error('catch-up failed'));
    else await guarded('restore state after catch-up', () => startupTasks.restoreState({ capped: result.capped }));
    startupRepair();
  };

  return { onReady: track(onReady, 'ClientReady') };
};
