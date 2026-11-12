const GET = 'SELECT value FROM meta WHERE key = ?';
const SET_IF_ABSENT = 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING';

// Installation-level facts (such as the Chroma generation). A key, once set, is never changed.
export const createMetaStore = ({ db }) => {
  const getSql = db.prepare(GET);
  const setSql = db.prepare(SET_IF_ABSENT);

  const get = (key) => getSql.get(key)?.value ?? null;

  const setIfAbsent = (key, value) => Number(setSql.run(key, String(value)).changes) > 0;

  return { get, setIfAbsent };
};
