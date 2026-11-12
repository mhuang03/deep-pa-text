import { checkProfile } from './memberProfileCheck.js';

// A failed check is forgotten so the next call retries; a settled one is reused for minCheckIntervalMs.
const run = async ({ checks, clock, check }, { entry, username, guild }) => {
  const forgetFailed = () => {
    if (checks.get(username) === entry) checks.delete(username);
  };
  try {
    const result = await check(username, guild);
    if (result.status === 'failed') forgetFailed();
    return result;
  } catch (error) {
    forgetFailed();
    throw error;
  } finally {
    entry.pending = false;
    entry.at = clock.now();
  }
};

const begin = (ctx, username, guild) => {
  const entry = { pending: true, at: 0 };
  entry.promise = run(ctx, { entry, username, guild });
  ctx.checks.set(username, entry);
  return entry.promise;
};

const isUsable = ({ clock, config }, entry) =>
  entry.pending || clock.now() - entry.at < config.profiles.minCheckIntervalMs;

const checkShared = (ctx, { username, guild, force }) => {
  const entry = ctx.checks.get(username);
  const reusable = entry && (entry.pending || (!force && isUsable(ctx, entry)));
  return reusable ? entry.promise : begin(ctx, username, guild);
};

const refreshAll = async (ctx, guild) => {
  const counts = { checked: 0, changed: 0, failed: 0 };
  for (const { username } of ctx.userDirectory.users) {
    const { status } = await checkShared(ctx, { username, guild, force: true });
    counts.checked += 1;
    if (status === 'changed') counts.changed += 1;
    if (status === 'failed') counts.failed += 1;
  }
  return counts;
};

export const createMemberProfiles = (deps) => {
  const checkContext = { ...deps, warnedAt: new Map() };
  const ctx = {
    checks: new Map(),
    clock: deps.clock,
    config: deps.config,
    userDirectory: deps.userDirectory,
    check: (username, guild) => checkProfile(checkContext, username, guild),
  };
  return {
    current: async (username, guild) => (await checkShared(ctx, { username, guild, force: false })).profile,
    refreshAll: (guild) => refreshAll(ctx, guild),
  };
};
