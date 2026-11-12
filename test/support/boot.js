// The only construction-aware file: it knows how the legacy app is built
// (module-level side effects, cwd-relative files, ?gen module graphs).
import { register } from 'node:module';
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as realDiscordJs from 'discord.js';
import { ENV } from './fixtures.js';
import { createFakeDiscord } from './fakes/discord.js';
import { createFakeChroma } from './fakes/chroma.js';
import { createFakeOpenAI } from './fakes/llm.js';
import { createFakeGifs } from './fakes/gifs.js';

register('./legacy-hooks.mjs', import.meta.url);

const ROOT = new URL('../../', import.meta.url).href;

// The fakes of the world that is currently importing the app; set only for the duration of the import.
let current = null;
let generation = 0;

const delegating = (pick) =>
  class {
    constructor(...args) {
      if (!current) throw new Error('boot: a faked library was constructed outside a world boot');
      const Target = pick(current);
      return new Target(...args);
    }
  };

mock.module('discord.js', {
  namedExports: { ...realDiscordJs, Client: delegating((f) => f.discord.Client) },
});
mock.module('chromadb', { namedExports: { ChromaClient: delegating((f) => f.chroma.ChromaClient) } });
mock.module('@chroma-core/openai', {
  namedExports: { OpenAIEmbeddingFunction: delegating((f) => f.chroma.OpenAIEmbeddingFunction) },
});
mock.module('openai', { defaultExport: delegating((f) => f.llm.OpenAI) });
mock.module('@giphy/js-fetch-api', { namedExports: { GiphyFetch: delegating((f) => f.gifs.GiphyFetch) } });

const createFakes = (options) => {
  const fakes = {
    discord: createFakeDiscord(),
    chroma: createFakeChroma(),
    llm: createFakeOpenAI(),
    gifs: createFakeGifs(),
  };
  if (options.failHeartbeat) fakes.chroma.state.failHeartbeat(options.failHeartbeat);
  return fakes;
};

const envFileText = () => Object.entries(ENV).map(([key, value]) => `${key}=${value}`).join('\n');

const writeFixtureFiles = (dir, { users, pingCache }) => {
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, '.env'), envFileText());
  fs.writeFileSync(path.join(dir, 'data', 'users.json'), JSON.stringify(users));
  fs.writeFileSync(path.join(dir, 'data', 'ping_caches.json'), JSON.stringify(pingCache));
};

const restoreEnv = (saved) => {
  Object.entries(saved).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
};

// Moves the process into a temp dir with the legacy app's files; returns the undo.
const enterSandbox = (options) => {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-world-'));
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
  const restore = () => {
    process.chdir(cwd);
    restoreEnv(savedEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    writeFixtureFiles(dir, options);
    Object.keys(ENV).forEach((key) => delete process.env[key]);
    process.chdir(dir);
  } catch (error) {
    restore();
    throw error;
  }
  return { dir, restore };
};

const importLegacy = async (fakes) => {
  const gen = ++generation;
  const load = (name) => import(`${ROOT}${name}.js?gen=${gen}`);
  current = fakes;
  try {
    await load('bot');
  } finally {
    current = null;
  }
  const [filterModule, db, api, prompt] = await Promise.all(['filter', 'db', 'api', 'prompt'].map(load));
  return { filterModule, db, api, prompt };
};

// Legacy mutates the message it is given; that is not part of the contract.
const copy = (msg) => ({ ...msg });

const buildSubject = ({ filterModule, db, api, prompt }) => ({
  filter: (msg) => filterModule.filter(copy(msg)),
  filterAnyAuthor: (msg) => filterModule.filterAnyAuthor(copy(msg)),
  recordMessage: async (msg) => {
    await db.recordMessage({ ...msg, reference: msg.reference ?? null });
  },
  semanticSearch: (author, msg) => db.semanticSearch(author, copy(msg)),
  randomSearch: (author) => db.randomSearch(author),
  searchLikelyRepliers: (msg) => db.searchLikelyRepliers(copy(msg)),
  getRAGResponse: (author, msg) => api.getRAGResponse(author, copy(msg)),
  getRandomResponse: (author) => api.getRandomResponse(author),
  processGIFs: (text) => api.processGIFs(text),
  SYSTEM_PROMPT: prompt.SYSTEM_PROMPT,
  ragInput: prompt.ragInput,
  contextlessInput: prompt.contextlessInput,
});

const openSqlite = (dir) => {
  const db = new DatabaseSync(path.join(dir, 'messages.db'), { readOnly: true });
  const plain = (rows) => rows.map((row) => ({ ...row }));
  return {
    all: (sql, ...params) => plain(db.prepare(sql).all(...params)),
    get: (sql, ...params) => {
      const row = db.prepare(sql).get(...params);
      return row && { ...row };
    },
    close: () => db.close(),
  };
};

export const bootBot = async (world) => {
  const fakes = createFakes(world.options);
  world.fakes = fakes;
  const sandbox = enterSandbox(world.options);
  try {
    const subject = buildSubject(await importLegacy(fakes));
    const sqlite = openSqlite(sandbox.dir);
    const dispose = () => {
      sqlite.close();
      sandbox.restore();
    };
    return { subject, sqlite: { all: sqlite.all, get: sqlite.get }, dispose };
  } catch (error) {
    sandbox.restore();
    throw error;
  }
};
