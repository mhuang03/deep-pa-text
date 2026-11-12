const INSERT = `
  INSERT INTO user_profiles (username, user_id, display_name, avatar_url, observed_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(username, observed_at) DO NOTHING
`;
const LATEST = 'SELECT * FROM user_profiles WHERE username = ? ORDER BY observed_at DESC LIMIT 1';
const ALL = `
  SELECT p.* FROM user_profiles p
  WHERE p.observed_at = (SELECT MAX(observed_at) FROM user_profiles WHERE username = p.username)
  ORDER BY p.username
`;
const NAMES = `
  SELECT display_name FROM user_profiles WHERE username = ?
  GROUP BY display_name ORDER BY MIN(observed_at)
`;

const toProfile = (row) => (row
  ? {
    username: row.username,
    userId: row.user_id ?? null,
    displayName: row.display_name,
    avatarURL: row.avatar_url ?? null,
  }
  : null);

// Append-only: every row is an observation, and the newest one is the stored profile.
export const createProfileStore = ({ db }) => {
  const insertSql = db.prepare(INSERT);
  const latestSql = db.prepare(LATEST);
  const allSql = db.prepare(ALL);
  const namesSql = db.prepare(NAMES);

  const record = ({ username, userId, displayName, avatarURL, observedAt }) => {
    insertSql.run(username, userId ?? null, displayName, avatarURL ?? null, observedAt);
  };

  const latest = (username) => toProfile(latestSql.get(username));
  const all = () => allSql.all().map(toProfile);
  const namesOf = (username) => namesSql.all(username).map((row) => row.display_name);

  return { latest, record, all, namesOf };
};
