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
