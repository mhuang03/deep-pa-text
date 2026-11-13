import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChain, chainReply } from '../../../../src/bot/handlers/messageChain.js';

const record = { id: 'r', content: 'hi', author: 'alice' };

const BOT = 'bot-user';
const PARENT = { id: 'p', persona: 'bob', content: 'what bob said', timestamp: 7 };
const USERS = [{ username: 'bob', name: 'Bob Example' }, { username: 'carol', name: 'Carol Example' }];

const chainDeps = (overrides = {}) => {
  const built = [];
  const deps = {
    config: { chain: { enabled: true }, mention: { enabled: true, namedPersona: true, fuzzyMinLength: 5, fuzzyWideMinLength: 8 } },
    client: { user: { id: BOT } },
    users: USERS,
    messageFilter: { filterForChain: (r) => (r.content ? r : null) },
    chainBuilder: {
      build: (target, parent, options) => { built.push({ target, parent, options }); return { persona: options.persona, turns: [], botTurns: 1 }; },
    },
    ...overrides,
  };
  return { deps, built };
};
const incoming = (content) => ({ message: { content }, record: { ...record, content, timestamp: 9 }, parent: PARENT });

test('buildChain is null when chains are disabled or there is no bot parent, and builds nothing', () => {
  const off = chainDeps({ config: { chain: { enabled: false }, mention: { enabled: true } } });
  assert.equal(buildChain(off.deps, incoming('hi')), null);
  const orphan = chainDeps();
  assert.equal(buildChain(orphan.deps, { ...incoming('hi'), parent: null }), null);
  assert.deepEqual([off.built, orphan.built], [[], []]);
});

test('a plain reply continues as the thread persona with its text unchanged', () => {
  const { deps, built } = chainDeps();
  const threaded = buildChain(deps, incoming('carol say more'));
  assert.equal(threaded.chain.persona, 'bob');
  assert.equal(threaded.target.content, 'carol say more');
  assert.deepEqual(built[0].options, { persona: 'bob' });
});

test('an unreplyable reply or an unbuildable chain gives no chain', () => {
  const empty = chainDeps();
  assert.equal(buildChain(empty.deps, incoming('')), null);
  const unbuildable = chainDeps({ chainBuilder: { build: () => null } });
  assert.equal(buildChain(unbuildable.deps, incoming('why')), null);
});

test('a ping that names another persona joins the thread as that persona, without the name in the text', () => {
  const { deps, built } = chainDeps();
  const threaded = buildChain(deps, incoming(`<@${BOT}> Carol, what about you`));
  assert.equal(threaded.chain.persona, 'carol');
  assert.equal(threaded.target.content, 'what about you');
  assert.deepEqual(built[0].options, { persona: 'carol' });
  assert.equal(built[0].parent, PARENT);
});

test('a ping that names the thread persona, or nobody, continues as the thread persona', () => {
  const same = chainDeps();
  const named = buildChain(same.deps, incoming(`<@${BOT}> bob what else`));
  assert.deepEqual([named.chain.persona, named.target.content], ['bob', 'what else']);
  const none = chainDeps();
  const plain = buildChain(none.deps, incoming(`<@${BOT}> what else`));
  assert.deepEqual([plain.chain.persona, plain.target.content], ['bob', 'what else']);
});

test('only another persona\'s name: that persona answers the bot message itself, with no incoming turn', () => {
  const { deps, built } = chainDeps();
  const threaded = buildChain(deps, incoming(`<@${BOT}> carol`));
  assert.equal(threaded.chain.persona, 'carol');
  assert.equal(built[0].target, null);
  assert.deepEqual(threaded.target, { id: 'p', author: 'bob', content: 'what bob said', timestamp: 7 });
});

test('only the thread persona\'s name, or only a ping, is not a chain', () => {
  const { deps, built } = chainDeps();
  assert.equal(buildChain(deps, incoming(`<@${BOT}> bob`)), null);
  assert.equal(buildChain(deps, incoming(`<@${BOT}>`)), null);
  assert.deepEqual(built, []);
});

test('with naming off a pinged name is part of the text', () => {
  const { deps } = chainDeps({
    config: { chain: { enabled: true }, mention: { enabled: true, namedPersona: false, fuzzyMinLength: 5, fuzzyWideMinLength: 8 } },
  });
  const threaded = buildChain(deps, incoming(`<@${BOT}> carol say more`));
  assert.deepEqual([threaded.chain.persona, threaded.target.content], ['bob', 'carol say more']);
});

const setup = () => {
  const events = [];
  const infos = [];
  const deps = {
    replyPolicy: { noteReply: (arg) => events.push(['noteReply', arg]), noteFailure: () => {} },
    responder: {
      respond: async (request) => { events.push(['respond', request.trigger, request.persona]); request.onDelivered(); return { response: 'yo' }; },
    },
    logger: { info: (line) => infos.push(line) },
  };
  const message = { author: { id: 'u1' }, guild: {}, channel: {} };
  const threaded = { chain: { persona: 'bob', botTurns: 2, turns: [] }, target: record };
  return { deps, events, infos, message, threaded };
};

test('a chain reply responds as the persona, arms the auto-reply limit and logs', async () => {
  const { deps, events, infos, message, threaded } = setup();
  await chainReply(deps, { message, threaded, lines: ['received'] });
  assert.deepEqual(events, [['respond', 'chain', 'bob'], ['noteReply', { resetMisses: false }]]);
  assert.match(infos[0], /received\n {4}\[CHAIN: bob, 2 bot turns\]\n {4}\[REPLY\] bob: yo$/);
});

test('a chain reply is never refused, whatever the thread length', async () => {
  const { deps, events, message, threaded } = setup();
  const long = { ...threaded, chain: { ...threaded.chain, botTurns: 99 } };
  await chainReply(deps, { message, threaded: long, lines: [] });
  await chainReply(deps, { message, threaded: long, lines: [] });
  assert.equal(events.filter((e) => e[0] === 'respond').length, 2);
});

test('a failed response propagates', async () => {
  const { deps, message, threaded } = setup();
  deps.responder.respond = async () => { throw new Error('boom'); };
  await assert.rejects(chainReply(deps, { message, threaded, lines: [] }), /boom/);
});
