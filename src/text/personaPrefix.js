// Finds a persona named at the start of a message: "bob what do you think", "Bob, ...", "bobbb ...",
// "micheal ...". Tolerant of case, accents, punctuation, stretched letters and small misspellings.
const MARKS = /\p{M}/gu;
const NOT_ALNUM = /[^\p{L}\p{N}]/gu;
const LEADING_NOISE = /^[^\p{L}\p{N}]*/u;
const LEADING_ALNUM = /^[\p{L}\p{N}]+/u;
const FIRST_WORD = /^\S+/;
const REPEATS = /(.)\1+/gu;
const POSSESSIVE_AND_SEPARATORS = /^(?:['’]s)?[\s,:;.!?\-–—]*/u;

const fold = (text) => text.normalize('NFKD').replace(MARKS, '').toLowerCase();
const normalize = (text) => fold(text).replace(NOT_ALNUM, '');
const squeeze = (text) => text.replace(REPEATS, '$1');

// Edit distance where swapping two neighbouring characters counts as one edit.
const editDistance = (a, b) => {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  rows[0] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      const swapped = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1];
      if (swapped) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
};

const namesOf = ({ username, name }) => {
  const first = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  return [...new Set([normalize(first), normalize(username)])].filter(Boolean);
};

// The two readings of the first word, each with the number of characters of text it covers.
const tokensOf = (text) => {
  const offset = text.match(LEADING_NOISE)[0].length;
  const run = text.slice(offset).match(LEADING_ALNUM)?.[0] ?? '';
  const word = text.match(FIRST_WORD)?.[0] ?? '';
  return [
    { key: normalize(run), end: offset + run.length },
    { key: normalize(word), end: word.length },
  ].filter((token) => token.key);
};

const allowedDistance = (name, { fuzzyMinLength, fuzzyWideMinLength }) => {
  if (name.length >= fuzzyWideMinLength) return 2;
  return name.length >= fuzzyMinLength ? 1 : 0;
};

const isClose = (token, name, limits) => {
  const allowed = allowedDistance(name, limits);
  return allowed > 0 && token[0] === name[0] && editDistance(token, name) <= allowed;
};

const METHODS = [
  { tokens: (all) => all, matches: (token, name) => token === name },
  { tokens: (all) => all, matches: (token, name) => squeeze(token) === squeeze(name) },
  { tokens: (all) => all.slice(0, 1), matches: isClose },
];

// Every (user, token) pair a method accepts.
const hitsOf = (method, { tokens, people, limits }) => people.flatMap(({ username, names }) => {
  const token = method.tokens(tokens).find((candidate) => names.some((name) => method.matches(candidate.key, name, limits)));
  return token ? [{ username, end: token.end }] : [];
});

const restAfter = (text, end) => text.slice(end).replace(POSSESSIVE_AND_SEPARATORS, '').trim();

export const matchPersonaPrefix = (text, users, limits) => {
  const tokens = tokensOf(text ?? '');
  if (tokens.length === 0) return null;
  const people = users.map((user) => ({ username: user.username, names: namesOf(user) }));
  for (const method of METHODS) {
    const hits = hitsOf(method, { tokens, people, limits });
    // More than one person fits: the name does not say who, so nobody is chosen.
    if (hits.length > 1) return null;
    if (hits.length === 1) return { persona: hits[0].username, rest: restAfter(text, hits[0].end) };
  }
  return null;
};
