// Themed corpora for the topic bank tests. Each theme has its own vocabulary, so the fake 64-dimension
// bag-of-words embedding puts a theme's messages close together and different themes apart.
import { fakeEmbed } from './fakes/chroma.js';

// Words are chosen so that every theme uses its own sixteen of the 64 embedding bins: themes never overlap.
export const THEMES = {
  camping: ['camp6', 'camp8', 'camp11', 'camp18', 'camp30', 'camp34', 'camp48', 'camp53', 'camp57', 'camp60', 'camp65', 'camp70'],
  cooking: ['cook5', 'cook16', 'cook18', 'cook25', 'cook26', 'cook37', 'cook45', 'cook52', 'cook57', 'cook59', 'cook71', 'cook72'],
  gaming: ['game2', 'game6', 'game8', 'game19', 'game22', 'game25', 'game29', 'game32', 'game38', 'game41', 'game54', 'game60'],
  music: ['tune2', 'tune6', 'tune8', 'tune14', 'tune20', 'tune25', 'tune29', 'tune30', 'tune34', 'tune37', 'tune62', 'tune72'],
};

const WORDS_PER_MESSAGE = 8;
const MULTIPLIER = 1664525;
const INCREMENT = 1013904223;
const MODULUS = 0x100000000;

// A deterministic pick of distinct words: the same (theme, index) always gives the same message.
const pickWords = (vocabulary, seed) => {
  const pool = [...vocabulary];
  const picked = [];
  let state = seed + 1;
  while (picked.length < WORDS_PER_MESSAGE) {
    state = (Math.imul(state, MULTIPLIER) + INCREMENT) >>> 0;
    picked.push(...pool.splice(Math.floor((state / MODULUS) * pool.length), 1));
  }
  return picked;
};

export const themedMessages = ({ theme, authors, count, from = 0, timestamp = 1_000_000 }) =>
  Array.from({ length: count }, (_, i) => {
    const index = from + i;
    const words = pickWords(THEMES[theme], index * 7 + theme.length);
    return {
      id: `${theme}-${index}`,
      author: authors[index % authors.length],
      content: `${words.join(' ')} ${index}`,
      timestamp: timestamp + index * 1000,
    };
  });

export const SHORT_FILLER = ['yeah lol', 'ok sounds good', 'yes', 'lol nice one', 'haha true that'];

// Long enough in characters but with fewer than five words, or one word repeated.
export const SNEAKY_FILLER = ['absolutely wonderful', 'yeah yeah yeah yeah yeah yeah', 'hahahahahahahahahahahahahaha lol ok'];

export const insertRows = (messageStore, rows) => rows.forEach((row) => {
  const record = { id: row.id, author: row.author, content: row.content, timestamp: row.timestamp, reference: null };
  messageStore.insertRaw(record);
  messageStore.insertFiltered(record, { inferReference: false });
});

// The stored embeddings the topic builder reads; ids in `missing` have none.
export const createFakeVectorStore = (rows, { missing = [] } = {}) => {
  const byId = new Map(rows.filter((row) => !missing.includes(row.id)).map((row) => [row.id, fakeEmbed(row.content)]));
  const calls = [];
  return {
    calls,
    getEmbeddings: async (ids, options) => {
      calls.push({ ids, options });
      return new Map(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)]));
    },
    query: async () => [],
  };
};

const themeOf = (texts) => {
  const scores = Object.entries(THEMES).map(([name, vocabulary]) => [
    name, texts.reduce((sum, text) => sum + vocabulary.filter((word) => text.includes(word)).length, 0),
  ]);
  return scores.sort((a, b) => b[1] - a[1])[0];
};

// Answers the labelling prompt by the theme the messages belong to; mixed or empty clusters are not usable.
export const labelByTheme = (request) => {
  const texts = JSON.parse(request.user).map((entry) => entry.text);
  const [name, score] = themeOf(texts);
  if (score === 0) return JSON.stringify({ usable: false, topic: '', summary: '' });
  return JSON.stringify({ usable: true, topic: `Talking about ${name}`, summary: `People discuss ${name} things.` });
};

// Every message uses all of the theme's words in a different order: identical bags of words, so the fake
// embedding puts a theme's messages at one point and k-means seeding cannot miss a theme.
export const permutedMessages = ({ theme, authors, count, from = 0, timestamp = 1_000_000 }) =>
  Array.from({ length: count }, (_, i) => {
    const index = from + i;
    const pool = [...THEMES[theme]];
    const words = [];
    let state = index * 31 + theme.length;
    while (pool.length > 0) {
      state = (Math.imul(state, MULTIPLIER) + INCREMENT) >>> 0;
      words.push(...pool.splice(Math.floor((state / MODULUS) * pool.length), 1));
    }
    return { id: `${theme}-${index}`, author: authors[index % authors.length], content: words.join(' '), timestamp: timestamp + index * 1000 };
  });
