import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../../src/storage/database.js';
import { loadConfig } from '../../../src/config.js';
import { createBotMessageStore } from '../../../src/storage/botMessageStore.js';

const row = (id, timestamp, extra = {}) => ({
  id, persona: 'bob', content: `text ${id}`, timestamp, reference: null, trigger: 'auto',
  conversation_id: null, turn_index: null, ...extra,
});

const setup = () => createBotMessageStore({ db: openDatabase(':memory:'), config: loadConfig({}) });

test('inserts and reads a bot message by id', () => {
  const store = setup();
  store.insert(row('1', 10, { reference: 'x', trigger: 'command' }));
  assert.deepEqual(store.getById('1'), row('1', 10, { reference: 'x', trigger: 'command' }));
});

test('getById returns null for an unknown id', () => {
  assert.equal(setup().getById('nope'), null);
});

test('inserting an existing id keeps the original row', () => {
  const store = setup();
  store.insert(row('1', 10));
  store.insert(row('1', 99, { content: 'changed', persona: 'carol' }));
  assert.deepEqual(store.getById('1'), row('1', 10));
});

test('an undefined reference is stored as null', () => {
  const store = setup();
  const { reference, ...rest } = row('1', 10);
  store.insert(rest);
  assert.equal(store.getById('1').reference, null);
});

test('recent returns newest first and respects the limit', () => {
  const store = setup();
  [row('a', 1), row('b', 3), row('c', 2)].forEach(store.insert);
  assert.deepEqual(store.recent({ limit: 2 }).map((m) => m.id), ['b', 'c']);
  assert.deepEqual(store.recent({ limit: 10 }).map((m) => m.id), ['b', 'c', 'a']);
  assert.deepEqual(store.recent({ limit: 0 }), []);
});

test('rows with the same timestamp are ordered by id descending', () => {
  const store = setup();
  [row('a', 5), row('c', 5), row('b', 5)].forEach(store.insert);
  assert.deepEqual(store.recent({ limit: 3 }).map((m) => m.id), ['c', 'b', 'a']);
});

test('recent requires a limit', () => {
  const store = setup();
  assert.throws(() => store.recent({}), /limit/);
  assert.throws(() => store.recent(), /limit/);
});

test('siblings returns the rows sharing persona, trigger and reference within the window, oldest first', () => {
  const store = setup();
  store.insert(row('b', 2000, { reference: 'x' }));
  store.insert(row('a', 1000, { reference: 'x' }));
  store.insert(row('c', 1000 + 60000, { reference: 'x' }));
  store.insert(row('late', 1000 + 60001, { reference: 'x' }));
  store.insert(row('other-ref', 1500, { reference: 'y' }));
  store.insert(row('other-persona', 1500, { reference: 'x', persona: 'carol' }));
  store.insert(row('other-trigger', 1500, { reference: 'x', trigger: 'chain' }));
  assert.deepEqual(store.siblings(store.getById('a')).map((r) => r.id), ['a', 'b', 'c']);
});

test('siblings of a revive burst match a null reference and keep separate revives apart', () => {
  const store = setup();
  store.insert(row('r1', 1000, { trigger: 'revive' }));
  store.insert(row('r2', 5000, { trigger: 'revive' }));
  store.insert(row('r3', 10_000_000, { trigger: 'revive' }));
  assert.deepEqual(store.siblings(store.getById('r2')).map((r) => r.id), ['r1', 'r2']);
});

test('softDelete marks a bot message once and keeps its row', () => {
  const store = setup();
  store.insert(row('1', 10));
  assert.equal(store.softDelete('1', 50), true);
  assert.equal(store.softDelete('1', 99), false);
  assert.equal(store.softDelete('nope', 99), false);
  assert.deepEqual(store.getById('1'), { ...row('1', 10), deleted: true });
});

test('recent and siblings exclude deleted bot messages', () => {
  const store = setup();
  [row('a', 1000), row('b', 2000), row('c', 3000)].forEach(store.insert);
  store.softDelete('b', 5000);
  assert.deepEqual(store.recent({ limit: 10 }).map((m) => m.id), ['c', 'a']);
  assert.deepEqual(store.siblings(store.getById('a')).map((m) => m.id), ['a', 'c']);
});

test('newest returns the newest visible row among the given triggers, or null', () => {
  const store = setup();
  store.insert(row('1', 10, { trigger: 'auto' }));
  store.insert(row('2', 30, { trigger: 'chain' }));
  store.insert(row('3', 20, { trigger: 'revive' }));
  store.insert(row('4', 40, { trigger: 'auto' }));
  store.softDelete('4', 99);
  assert.equal(store.newest({ triggers: ['auto', 'revive'] }).id, '3');
  assert.equal(store.newest({ triggers: ['chain'] }).id, '2');
  assert.equal(store.newest({ triggers: ['command'] }), null);
  assert.throws(() => store.newest({ triggers: [] }), /non-empty/);
});

test('stores the conversation id and turn index and reads them back', () => {
  const store = setup();
  store.insert(row('1', 10, { conversationId: 'c1', turnIndex: 2, trigger: 'conversation', reference: 'p' }));
  assert.deepEqual(store.getById('1'), row('1', 10, {
    trigger: 'conversation', reference: 'p', conversation_id: 'c1', turn_index: 2,
  }));
});

test('without a conversation the id and turn index default to null', () => {
  const store = setup();
  store.insert({ id: '1', persona: 'bob', content: 'x', timestamp: 1, trigger: 'auto' });
  const stored = store.getById('1');
  assert.equal(stored.conversation_id, null);
  assert.equal(stored.turn_index, null);
});

test('newest finds a conversation turn among its own trigger only', () => {
  const store = setup();
  store.insert(row('1', 10, { trigger: 'conversation', conversationId: 'c1', turnIndex: 0 }));
  store.insert(row('2', 20, { trigger: 'revive' }));
  assert.equal(store.newest({ triggers: ['conversation'] }).id, '1');
});
