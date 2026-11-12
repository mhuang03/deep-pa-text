// One live check of a member's Discord profile against the stored one.
import { withTimeout } from '../util/withTimeout.js';

const FIELDS = ['userId', 'displayName', 'avatarURL'];

const fallbackProfile = (username) => ({ username, userId: null, displayName: username, avatarURL: null });

const changedFields = (stored, live) =>
  (stored ? FIELDS.filter((field) => (stored[field] ?? null) !== (live[field] ?? null)) : FIELDS);

const warnOnce = ({ warnedAt, clock, config, logger }, username, error) => {
  const last = warnedAt.get(username);
  if (last !== undefined && clock.now() - last < config.profiles.refreshIntervalMs) return;
  warnedAt.set(username, clock.now());
  logger.warn(`Could not read the Discord profile of ${username}; using the stored one:`, error);
};

const lookup = ({ fetchMember, userDirectory, config, clock }, { guild, username, stored }) => withTimeout(
  fetchMember(guild, {
    username, userId: stored?.userId ?? userDirectory.idOf(username), searchLimit: config.profiles.searchLimit,
  }),
  {
    ms: config.profiles.lookupTimeoutMs,
    label: `member lookup for ${username}`,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  },
);

const keep = (ctx, { username, stored, reason }) => {
  warnOnce(ctx, username, reason instanceof Error ? reason : new Error(reason));
  return { profile: stored ?? fallbackProfile(username), status: 'failed' };
};

const adopt = ({ profileStore, clock, logger }, { username, stored, live }) => {
  const changed = changedFields(stored, live);
  if (changed.length > 0) {
    profileStore.record({ username, ...live, observedAt: clock.now() });
    logger.info(`Profile of ${username} changed: ${changed.join(', ')}`);
  }
  return { profile: { username, ...live }, status: changed.length > 0 ? 'changed' : 'unchanged' };
};

export const checkProfile = async (ctx, username, guild) => {
  const stored = ctx.profileStore.latest(username);
  let live;
  try {
    live = await lookup(ctx, { guild, username, stored });
  } catch (error) {
    return keep(ctx, { username, stored, reason: error });
  }
  return live
    ? adopt(ctx, { username, stored, live })
    : keep(ctx, { username, stored, reason: 'member not found' });
};
