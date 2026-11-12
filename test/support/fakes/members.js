// Guild member fake: REST-style lookups only, like the real adapter uses (no gateway query).
const DEFAULT_AVATAR_BASE = 'https://cdn.example/avatars';
export const UNKNOWN_MEMBER = 10007;

const createMember = ({ username, id = `user-${username}`, displayName = `${username}-display`, avatarURL }) => {
  const member = {
    user: { id, username },
    displayName,
    avatar: avatarURL === undefined ? `${DEFAULT_AVATAR_BASE}/${username}.png` : avatarURL,
    displayAvatarURL: () => member.avatar,
  };
  return member;
};

const unknownMember = () =>
  Object.assign(new Error('fake discord: Unknown Member'), { code: UNKNOWN_MEMBER });

export const createMembers = () => {
  const byId = new Map();
  let failure = null;
  let hanging = false;

  const find = (key) => byId.get(key) ?? [...byId.values()].find((m) => m.user.username === key);

  // `calls` records the method and its arguments; a lookup is counted even when it then fails or hangs.
  const guard = async (method, args) => {
    members.calls.push({ method, args });
    if (hanging) await new Promise(() => {});
    if (failure) throw failure;
  };

  const members = {
    calls: [],
    add: (fields) => {
      const member = createMember(fields);
      byId.set(member.user.id, member);
      return member;
    },
    remove: (key) => {
      const member = find(key);
      if (member) byId.delete(member.user.id);
    },
    // Fields: username, displayName, avatarURL.
    update: (key, { username, displayName, avatarURL } = {}) => {
      const member = find(key);
      if (!member) throw new Error(`fake discord: no member ${key}`);
      if (username !== undefined) member.user.username = username;
      if (displayName !== undefined) member.displayName = displayName;
      if (avatarURL !== undefined) member.avatar = avatarURL;
    },
    setFailing: (error) => {
      failure = error ? (error === true ? new Error('fake discord: member fetch failed') : error) : null;
    },
    setHanging: (value) => {
      hanging = Boolean(value);
    },
    async fetch({ user, force } = {}) {
      await guard('fetch', { user, force });
      const member = byId.get(user);
      if (!member) throw unknownMember();
      return member;
    },
    async search({ query, limit } = {}) {
      await guard('search', { query, limit });
      const prefix = query.toLowerCase();
      const hits = [...byId.values()].filter((m) =>
        m.user.username.toLowerCase().startsWith(prefix) || m.displayName.toLowerCase().startsWith(prefix));
      return new Map(hits.slice(0, limit).map((m) => [m.user.id, m]));
    },
  };
  return members;
};
