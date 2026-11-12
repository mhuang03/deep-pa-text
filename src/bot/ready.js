// What happens once the gateway is ready: restore state, start the timers, catch up on missed messages.
const revivePeriod = ({ revive }) => (revive.override ? revive.overrideCheckIntervalMs : revive.checkIntervalMs);

// A failed step is logged and the next one still runs.
const guarded = async (logger, { label, run, level = 'error' }) => {
  try {
    return await run();
  } catch (error) {
    logger[level](`Startup step "${label}" failed:`, error);
    return null;
  }
};

// The first refresh is not awaited: it must not delay ready. The handler catches its own errors.
const startProfileRefresh = ({ config, handlers, lifecycle }) => {
  const period = config.profiles.refreshIntervalMs;
  if (period === 0) return;
  const refresh = lifecycle.track(handlers.profileRefresh, 'profileRefresh');
  refresh();
  lifecycle.every(refresh, period);
};

const startIntervals = (deps) => {
  const { config, handlers, lifecycle, vectorHealth } = deps;
  lifecycle.every(lifecycle.track(handlers.reviveTick, 'reviveTick'), revivePeriod(config));
  startProfileRefresh(deps);
  lifecycle.every(lifecycle.track(vectorHealth.repair, 'vectorRepair'), config.vector.repairIntervalMs);
};

const catchUp = async ({ client, config, startupTasks }) => {
  const channel = await client.channels.fetch(config.discord.channelId);
  return startupTasks.catchUp(channel);
};

const restoreAfterCatchUp = async (deps, result) => {
  const { startupTasks, vectorHealth, logger } = deps;
  if (result === null) return vectorHealth.noteFailure(new Error('catch-up failed'));
  return guarded(logger, {
    label: 'restore state after catch-up', run: () => startupTasks.restoreState({ capped: result.capped }),
  });
};

const onReady = async (deps, state) => {
  const { client, startupTasks, vectorHealth, lifecycle, logger } = deps;
  if (state.started) return;
  state.started = true;
  logger.info(`Logged in as ${client.user.tag}`);
  await guarded(logger, { label: 'restore state', run: () => startupTasks.restoreState() });
  startIntervals(deps);
  const caught = await guarded(logger, { label: 'catch up', run: () => catchUp(deps), level: 'warn' });
  await restoreAfterCatchUp(deps, caught);
  // Not awaited: the repair can take long and must not delay ready. It never throws.
  lifecycle.track(vectorHealth.startupRepair, 'vectorStartupRepair')();
};

export const createReady = (deps) => {
  const state = { started: false };
  return { onReady: deps.lifecycle.track(() => onReady(deps, state), 'ClientReady') };
};
