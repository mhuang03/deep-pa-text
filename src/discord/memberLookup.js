export const UNKNOWN_MEMBER_CODE = 10007;
export const UNKNOWN_USER_CODE = 10013;

const MISSING_CODES = [UNKNOWN_MEMBER_CODE, UNKNOWN_USER_CODE];

const toLookupResult = (member) => ({
  userId: member.user.id,
  displayName: member.displayName,
  avatarURL: member.displayAvatarURL() ?? null,
});

// force bypasses discord.js's member cache, which is not kept fresh without the GuildMembers intent.
const fetchById = async (guild, userId) => {
  try {
    return await guild.members.fetch({ user: userId, force: true });
  } catch (error) {
    if (MISSING_CODES.includes(error?.code)) return null;
    throw error;
  }
};

// The search matches prefixes of usernames and nicknames, so only an exact username counts.
const searchByUsername = async (guild, { username, searchLimit }) => {
  const found = await guild.members.search({ query: username, limit: searchLimit });
  const wanted = username.toLowerCase();
  return [...found.values()].find((member) => member.user.username.toLowerCase() === wanted) ?? null;
};

// REST only: the gateway member query would need a privileged intent and can go unanswered.
export const fetchMember = async (guild, { username, userId, searchLimit }) => {
  const member = userId
    ? await fetchById(guild, userId)
    : await searchByUsername(guild, { username, searchLimit });
  return member ? toLookupResult(member) : null;
};
