// Construction-agnostic world: patches process globals, boots the bot through
// boot.js and exposes the fakes' state plus helpers to drive the bot.
import { mock } from 'node:test';
import { Events } from 'discord.js';
import { bootBot } from './boot.js';
import { BASE_TIME, ENV, PING_CACHE, USERS } from './fixtures.js';

const MAX_TICK_MS = 600_000;
const CONSOLE_METHODS = ['log', 'warn', 'error'];

let isOpen = false;

const createRandom = (initial) => {
  let source = initial;
  let index = 0;
  let calls = 0;
  const next = () => {
    calls += 1;
    const position = index++;
    if (typeof source === 'function') return source(position);
    if (!Array.isArray(source)) return source;
    return source[Math.min(position, source.length - 1)];
  };
  return {
    next,
    set: (x) => {
      source = x;
      index = 0;
    },
    get calls() {
      return calls;
    },
  };
};

const installPatches = (world, random, undo) => {
  const mockMethod = (target, name, impl) => {
    const handle = mock.method(target, name, impl);
    undo.push(() => handle.mock.restore());
  };
  CONSOLE_METHODS.forEach((name) => mockMethod(console, name, (...args) => world.logs[name].push(args)));
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: world.options.now });
  undo.push(() => mock.timers.reset());
  mockMethod(Math, 'random', random.next);
  mockMethod(globalThis, 'fetch', (...args) => world.fakes.gifs.fetch(...args));
};

const runUndo = (undo) => {
  const failures = [];
  undo.splice(0).reverse().forEach((fn) => {
    try {
      fn();
    } catch (error) {
      failures.push(error);
    }
  });
  if (failures.length > 0) throw failures[0];
};

const normalizeOptions = ({
  users = USERS, pingCache = PING_CACHE, now = BASE_TIME, random = 0.99, ...rest
} = {}) => ({ users, pingCache, now, random, ...rest });

const createDriver = (world) => {
  const settle = () => world.fakes.discord.state.settle();
  const emit = async (event, payload) => {
    world.fakes.discord.state.client.emit(event, payload);
    await settle();
  };
  const advance = async (ms) => {
    for (let left = ms; left > 0; left -= MAX_TICK_MS) {
      mock.timers.tick(Math.min(left, MAX_TICK_MS));
      await settle();
    }
    if (ms <= 0) await settle();
  };
  return { settle, emit, advance };
};

const isFakeMessage = (x) => x && typeof x === 'object' && 'createdTimestamp' in x;

const buildWorld = (options, random) => {
  const world = { options, env: { ...ENV, ...options.env }, fakes: null, logs: { log: [], warn: [], error: [] } };
  const driver = createDriver(world);
  const discordState = () => world.fakes.discord.state;
  const now = () => Date.now();

  Object.assign(world, {
    now,
    settle: driver.settle,
    advance: driver.advance,
    advanceTo: async (epochMs) => {
      if (epochMs < now()) throw new Error(`advanceTo: ${epochMs} is in the past (now ${now()})`);
      await driver.advance(epochMs - now());
    },
    setRandom: random.set,
    ready: () => driver.emit(Events.ClientReady, discordState().client),
    emitMessage: async (fields) => {
      const message = discordState().addHistory(fields);
      await driver.emit(Events.MessageCreate, message);
      return message;
    },
    addHistory: (fields) => discordState().addHistory(fields),
    emitInteraction: (interaction) => driver.emit(Events.InteractionCreate, interaction),
    openReplyCommand: async ({ target, user }) => {
      const targetMessage = isFakeMessage(target) ? target : discordState().makeMessage(target);
      const interaction = world.fakes.discord.makeReplyCommand({ target: targetMessage, user });
      await driver.emit(Events.InteractionCreate, interaction);
      return interaction;
    },
    seed: async (messages) => {
      const stored = [];
      for (const msg of messages) {
        await world.subject.recordMessage(msg);
        const row = world.sqlite.get('SELECT 1 AS found FROM filtered_messages WHERE id = ?', msg.id);
        stored.push(Boolean(row));
      }
      return stored;
    },
  });
  Object.defineProperties(world, {
    randomCalls: { get: () => random.calls },
    errors: { get: () => discordState().errors },
    discord: { get: () => discordState() },
    llm: { get: () => world.fakes.llm.state },
    gifs: { get: () => world.fakes.gifs.state },
    chroma: { get: () => world.fakes.chroma.state },
  });
  return world;
};

const finishClose = async (world, undo) => {
  if (world.fakes) {
    world.fakes.discord.state.closePending();
    await world.settle();
  }
  try {
    runUndo(undo);
  } finally {
    isOpen = false;
  }
};

export const createWorld = async (rawOptions) => {
  if (isOpen) throw new Error('createWorld: a world is already open; close it first');
  isOpen = true;
  const options = normalizeOptions(rawOptions);
  const random = createRandom(options.random);
  const world = buildWorld(options, random);
  const undo = [];
  try {
    installPatches(world, random, undo);
    const booted = await bootBot(world);
    undo.push(booted.dispose);
    Object.assign(world, { subject: booted.subject, sqlite: booted.sqlite });
  } catch (error) {
    await finishClose(world, undo).catch(() => {});
    throw error;
  }
  let closing = null;
  world.close = () => {
    closing ??= finishClose(world, undo);
    return closing;
  };
  return world;
};
