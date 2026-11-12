import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChain, chainReply } from '../../../../src/bot/handlers/messageChain.js';

const record = { id: 'r', content: 'hi', author: 'alice' };

test('buildChain is null when chains are disabled and builds nothing', () => {
  let built = false;
  const deps = {
    config: { chain: { enabled: false } },
    messageFilter: { filterForChain: () => record },
    chainBuilder: { build: () => { built = true; return {}; } },
  };
  assert.equal(buildChain(deps, record, { id: 'p' }), null);
  assert.equal(built, false);
});

test('buildChain needs a bot parent, a replyable target and a buildable chain', () => {
  const chain = { persona: 'bob', turns: [], botTurns: 1 };
  const deps = (overrides) => ({
    config: { chain: { enabled: true } },
    messageFilter: { filterForChain: () => record },
    chainBuilder: { build: () => chain },
    ...overrides,
  });
  assert.equal(buildChain(deps(), record, null), null);
  assert.equal(buildChain(deps({ messageFilter: { filterForChain: () => null } }), record, { id: 'p' }), null);
  assert.equal(buildChain(deps({ chainBuilder: { build: () => null } }), record, { id: 'p' }), null);
  assert.deepEqual(buildChain(deps(), record, { id: 'p' }), { chain, target: record });
});

const setup = ({ decision = { reply: true, reason: 'chain-guaranteed' } } = {}) => {
  const events = [];
  const infos = [];
  const deps = {
    chainPolicy: {
      decide: (arg) => { events.push(['decide', arg]); return decision; },
      begin: (arg) => events.push(['begin', arg]),
      end: () => events.push('end'),
    },
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

test('a refused chain decision is logged and nothing starts', async () => {
  const { deps, events, infos, message, threaded } = setup({ decision: { reply: false, reason: 'chain-limit' } });
  await chainReply(deps, { message, threaded, lines: ['received'] });
  assert.deepEqual(events.map((e) => (Array.isArray(e) ? e[0] : e)), ['decide']);
  assert.equal(infos.length, 1);
  assert.match(infos[0], /received\n.*chain-limit, no reply/);
});

test('an accepted chain reply begins, responds as the persona, logs and ends', async () => {
  const { deps, events, infos, message, threaded } = setup();
  await chainReply(deps, { message, threaded, lines: ['received'] });
  assert.deepEqual(events.map((e) => (Array.isArray(e) ? e[0] : e)), ['decide', 'begin', 'respond', 'noteReply', 'end']);
  assert.deepEqual(events[0][1], { persona: 'bob', turns: [], botTurns: 2, userId: 'u1' });
  assert.deepEqual(events[1][1], { userId: 'u1' });
  assert.deepEqual(events[3][1], { resetMisses: false });
  assert.match(infos[0], /\[REPLY\] bob: yo/);
});

test('the chain slot is released when the response fails', async () => {
  const { deps, events, message, threaded } = setup();
  deps.responder.respond = async () => { throw new Error('boom'); };
  await assert.rejects(chainReply(deps, { message, threaded, lines: [] }), /boom/);
  assert.equal(events.at(-1), 'end');
});
