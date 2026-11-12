import { withTimeout } from '../util/withTimeout.js';

const FIELDS = ['userId', 'displayName', 'avatarURL'];

const fallbackProfile = (username) => ({ username, userId: null, displayName: username, avatarURL: null });

const changedFields = (stored, live) =>
  (stored ? FIELDS.filter((field) => (stored[field] ?? null) !== (live[field] ?? null)) : FIELDS);

export const createMemberProfiles = ({
  profileStore, fetchMember, userDirectory, config, clock, logger,
}) => {
  const { minCheckIntervalMs, lookupTimeoutMs, searchLimit, refreshIntervalMs } = config.profiles;
  const checks = new Map();
  const warnedAt = new Map();

  const warnOnce = (username, error) => {
    const last = warnedAt.get(username);
    if (last !== undefined && clock.now() - last < refreshIntervalMs) return;
    warnedAt.set(username, clock.now());
    logger.warn(`Could not read the Discord profile of ${username}; using the stored one:`, error);
  };

  const lookup = (guild, username, stored) => withTimeout(
    fetchMember(guild, { username, userId: stored?.userId ?? userDirectory.idOf(username), searchLimit }),
    {
      ms: lookupTimeoutMs,
      label: `member lookup for ${username}`,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );

  const keep = (username, stored, reason) => {
    warnOnce(username, reason instanceof Error ? reason : new Error(reason));
    return { profile: stored ?? fallbackProfile(username), status: 'failed' };
  };

  const adopt = (username, stored, live) => {
    const changed = changedFields(stored, live);
    if (changed.length > 0) {
      profileStore.record({ username, ...live, observedAt: clock.now() });
      logger.info(`Profile of ${username} changed: ${changed.join(', ')}`);
    }
    return { profile: { username, ...live }, status: changed.length > 0 ? 'changed' : 'unchanged' };
  };

  const check = async (username, guild) => {
    const stored = profileStore.latest(username);
    let live;
    try {
      live = await lookup(guild, username, stored);
    } catch (error) {
      return keep(username, stored, error);
    }
    return live ? adopt(username, stored, live) : keep(username, stored, 'member not found');
  };

  const begin = (username, guild) => {
    const entry = { pending: true, at: 0 };
    const settle = () => {
      entry.pending = false;
      entry.at = clock.now();
    };
    const forgetFailed = () => {
      if (checks.get(username) === entry) checks.delete(username);
    };
    entry.promise = check(username, guild).then((result) => {
      settle();
      if (result.status === 'failed') forgetFailed();
      return result;
    }, (error) => {
      settle();
      forgetFailed();
      throw error;
    });
    checks.set(username, entry);
    return entry.promise;
  };

  const isUsable = (entry) => entry.pending || clock.now() - entry.at < minCheckIntervalMs;

  const checkShared = (username, guild, { force }) => {
    const entry = checks.get(username);
    const reusable = entry && (entry.pending || (!force && isUsable(entry)));
    return reusable ? entry.promise : begin(username, guild);
  };

  const current = async (username, guild) => (await checkShared(username, guild, { force: false })).profile;

  const refreshAll = async (guild) => {
    const counts = { checked: 0, changed: 0, failed: 0 };
    for (const { username } of userDirectory.users) {
      const { status } = await checkShared(username, guild, { force: true });
      counts.checked += 1;
      if (status === 'changed') counts.changed += 1;
      if (status === 'failed') counts.failed += 1;
    }
    return counts;
  };

  return { current, refreshAll };
};
