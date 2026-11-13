import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMention, mentionReply } from '../../../../src/bot/handlers/messageMention.js';

const BOT = 'bot-user';
const record = (content, extra = {}) => ({ id: 'm1', author: 'alice', content, timestamp: 50, reference: null, ...extra });

const USERS = [{ username: 'bob', name: 'Bob Example' }, { username: 'cc', name: 'Carol Example' }, { username: 'alice', name: 'Alice Example' }];
const NAMING = { namedPersona: true, fuzzyMinLength: 5, fuzzyWideMinLength: 8 };

const setup = ({ previous = null, stored = null, enabled = true, namedPersona = true } = {}) => {
  const calls = { respond: [], picked: [], infos: [], warns: [], noted: [], previousRaw: [] };
  const deps = {
    client: { user: { id: BOT } },
    config: { mention: { ...NAMING, enabled, namedPersona } },
    users: USERS,
    messageFilter: { filterForChain: (r) => (r.content ? r : null) },
    messageStore: {
      getRaw: (id) => (stored?.id === id ? stored : null),
      previousRaw: (arg) => { calls.previousRaw.push(arg); return previous; },
    },
    personaSelector: { pickReplier: async (target) => { calls.picked.push(target); return 'picked'; } },
    replyPolicy: { noteReply: (arg) => calls.noted.push(arg) },
    responder: { respond: async (request) => { calls.respond.push(request); request.onDelivered(); return { response: 'sure' }; } },
    logger: { info: (line) => calls.infos.push(line), warn: (...args) => calls.warns.push(args) },
  };
  const message = (content, fetched) => ({
    id: 'm1', content, guild: { id: 'g' }, channel: { id: 'c' },
    fetchReference: async () => { if (!fetched) throw new Error('gone'); return fetched; },
  });
  return { deps, calls, message };
};

test('isMention needs the feature on, a known bot id and a written ping', () => {
  const { deps } = setup();
  assert.equal(isMention(deps, { content: `<@${BOT}> hi` }), true);
  assert.equal(isMention(deps, { content: 'hi there' }), false);
  assert.equal(isMention({ ...deps, client: { user: null } }, { content: `<@${BOT}> hi` }), false);
  assert.equal(isMention(setup({ enabled: false }).deps, { content: `<@${BOT}> hi` }), false);
});

test('a ping with text answers that text, with the mention removed, as the picked replier', async () => {
  const { deps, calls, message } = setup();
  const msg = message(`<@${BOT}> why though`);
  await mentionReply(deps, { message: msg, record: record(msg.content), lines: ['received'] });
  const [request] = calls.respond;
  assert.equal(request.trigger, 'mention');
  assert.equal(request.persona, 'picked');
  assert.equal(request.target.content, 'why though');
  assert.equal(calls.picked[0].content, 'why though');
  assert.deepEqual(request.via, { type: 'reply', message: msg });
  assert.deepEqual(calls.noted, [{ resetMisses: false }]);
  assert.equal(calls.infos[0], 'received\n    [REPLY] picked: sure');
});

test('a bare ping answers the message before it', async () => {
  const previous = { id: 'p', author: 'carol', content: 'who is up for food', timestamp: 40, deleted: false };
  const { deps, calls, message } = setup({ previous });
  await mentionReply(deps, { message: message(`<@${BOT}>`), record: record(`<@${BOT}>`), lines: [] });
  assert.deepEqual(calls.previousRaw, [{ before: 50, excludeId: 'm1' }]);
  assert.equal(calls.respond[0].target.id, 'p');
});

test('a bare ping in a reply answers the stored referenced message, else the fetched one', async () => {
  const stored = { id: 'old', author: 'dave', content: 'an older stored message', timestamp: 3, deleted: false };
  const first = setup({ stored });
  await mentionReply(first.deps, { message: first.message(`<@${BOT}>`), record: record(`<@${BOT}>`, { reference: 'old' }), lines: [] });
  assert.equal(first.calls.respond[0].target.id, 'old');
  assert.deepEqual(first.calls.previousRaw, []);

  const second = setup();
  const fetched = { id: 'f1', author: { username: 'carol' }, content: 'only on discord', createdTimestamp: 9, reference: null };
  await mentionReply(second.deps, {
    message: second.message(`<@${BOT}>`, fetched), record: record(`<@${BOT}>`, { reference: 'f1' }), lines: [],
  });
  assert.deepEqual(
    { id: second.calls.respond[0].target.id, author: second.calls.respond[0].target.author },
    { id: 'f1', author: 'carol' },
  );
});

test('nothing to answer is logged and nothing is generated', async () => {
  const cases = [
    setup({ previous: null }),
    setup({ previous: { id: 'p', author: 'carol', content: 'deleted since', timestamp: 1, deleted: true } }),
    setup({ previous: { id: 'p', author: 'carol', content: '', timestamp: 1, deleted: false } }),
  ];
  for (const { deps, calls, message } of cases) {
    await mentionReply(deps, { message: message(`<@${BOT}>`), record: record(`<@${BOT}>`), lines: ['received'] });
    assert.deepEqual([calls.respond, calls.picked], [[], []]);
    assert.equal(calls.infos[0], 'received\n    [MENTION: nothing to reply to]');
  }
  const unfetchable = setup();
  await mentionReply(unfetchable.deps, {
    message: unfetchable.message(`<@${BOT}>`), record: record(`<@${BOT}>`, { reference: 'nowhere' }), lines: [],
  });
  assert.equal(unfetchable.calls.respond.length, 0);
  assert.equal(unfetchable.calls.warns.length, 1);
});

test('a failed response propagates and notes nothing', async () => {
  const { deps, calls, message } = setup();
  deps.responder.respond = async () => { throw new Error('llm down'); };
  await assert.rejects(
    mentionReply(deps, { message: message(`<@${BOT}> hi there`), record: record(`<@${BOT}> hi there`), lines: [] }),
    /llm down/,
  );
  assert.deepEqual(calls.noted, []);
});

test('a message that starts with a persona name is answered by that persona, without a pick', async () => {
  const { deps, calls, message } = setup();
  const content = `<@${BOT}> Carol, what do you think`;
  await mentionReply(deps, { message: message(content), record: record(content), lines: [] });
  assert.equal(calls.respond[0].persona, 'cc');
  assert.equal(calls.respond[0].target.content, 'what do you think');
  assert.deepEqual(calls.picked, []);
});

test('the named persona may be the author, and a misspelled name still counts', async () => {
  const { deps, calls, message } = setup();
  const own = `<@${BOT}> alice what would you say`;
  await mentionReply(deps, { message: message(own), record: record(own), lines: [] });
  const typo = `<@${BOT}> caorl what would you say`;
  await mentionReply(deps, { message: message(typo), record: record(typo), lines: [] });
  assert.deepEqual(calls.respond.map((r) => r.persona), ['alice', 'cc']);
});

test('a name alone answers the pointed-at message as that persona', async () => {
  const previous = { id: 'p', author: 'dave', content: 'who is up for food', timestamp: 40, deleted: false };
  const { deps, calls, message } = setup({ previous });
  await mentionReply(deps, { message: message(`<@${BOT}> bob`), record: record(`<@${BOT}> bob`), lines: [] });
  assert.deepEqual({ persona: calls.respond[0].persona, target: calls.respond[0].target.id }, { persona: 'bob', target: 'p' });
});

test('with naming off, or no name at the start, the replier is picked and the text is kept whole', async () => {
  const off = setup({ namedPersona: false });
  const content = `<@${BOT}> bob what do you think`;
  await mentionReply(off.deps, { message: off.message(content), record: record(content), lines: [] });
  assert.equal(off.calls.respond[0].persona, 'picked');
  assert.equal(off.calls.respond[0].target.content, 'bob what do you think');
  const none = setup();
  const other = `<@${BOT}> what does bob think`;
  await mentionReply(none.deps, { message: none.message(other), record: record(other), lines: [] });
  assert.equal(none.calls.respond[0].persona, 'picked');
});
