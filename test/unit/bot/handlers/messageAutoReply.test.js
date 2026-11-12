import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoReply, respondTo } from '../../../../src/bot/handlers/messageAutoReply.js';

const setup = ({ respondError = null, pickError = null } = {}) => {
  const events = [];
  const deps = {
    activity: { noteBot: () => { events.push('noteBot'); return () => events.push('undo'); } },
    replyPolicy: {
      noteReply: (arg) => events.push(['noteReply', arg]),
      noteFailure: () => events.push('noteFailure'),
    },
    personaSelector: { pickReplier: async () => { if (pickError) throw pickError; return 'bob'; } },
    responder: {
      respond: async (request) => {
        events.push(['respond', request.trigger, request.via.type]);
        if (respondError) throw respondError;
        request.onDelivered();
        return { response: 'hello' };
      },
    },
  };
  const message = { id: 'm', guild: { id: 'g' }, channel: { id: 'c' } };
  return { deps, events, message };
};

test('respondTo adds the guild, channel and a reply via to the request', async () => {
  const { deps, message } = setup();
  let seen;
  deps.responder.respond = async (request) => { seen = request; return { response: 'x' }; };
  await respondTo(deps, { message, request: { trigger: 'chain', persona: 'bob' } });
  assert.deepEqual(seen.guild, { id: 'g' });
  assert.deepEqual(seen.channel, { id: 'c' });
  assert.deepEqual(seen.via, { type: 'reply', message });
});

test('respondTo arms the rate limit when delivery failed, but not for other failures', async () => {
  const delivery = setup({ respondError: Object.assign(new Error('x'), { stage: 'delivery' }) });
  await assert.rejects(respondTo(delivery.deps, { message: delivery.message, request: { trigger: 'auto' } }));
  assert.deepEqual(delivery.events.filter((e) => e[0] === 'noteReply'), [['noteReply', { resetMisses: false }]]);
  const other = setup({ respondError: Object.assign(new Error('x'), { stage: 'generation' }) });
  await assert.rejects(respondTo(other.deps, { message: other.message, request: { trigger: 'auto' } }));
  assert.deepEqual(other.events.filter((e) => e[0] === 'noteReply'), []);
});

test('a delivered auto reply claims activity twice, resets misses and releases the slot', async () => {
  const { deps, events, message } = setup();
  const released = [];
  const line = await autoReply(deps, { message, target: { id: 't' }, decision: { release: () => released.push(true) } });
  assert.equal(line, '    [REPLY] bob: hello');
  assert.deepEqual(events.filter((e) => e === 'noteBot').length, 2);
  assert.deepEqual(events.find((e) => e[0] === 'noteReply'), ['noteReply', { resetMisses: true }]);
  assert.equal(events.includes('undo'), false);
  assert.deepEqual(released, [true]);
});

test('a generation failure undoes the activity, cools the policy down and still releases the slot', async () => {
  const { deps, events, message } = setup({ pickError: new Error('no persona') });
  const released = [];
  await assert.rejects(autoReply(deps, { message, target: {}, decision: { release: () => released.push(true) } }), /no persona/);
  assert.ok(events.includes('undo'));
  assert.ok(events.includes('noteFailure'));
  assert.deepEqual(released, [true]);
});

test('a delivery failure undoes the activity but does not start a failure cooldown', async () => {
  const { deps, events, message } = setup({ respondError: Object.assign(new Error('x'), { stage: 'delivery' }) });
  await assert.rejects(autoReply(deps, { message, target: {}, decision: { release: () => {} } }));
  assert.ok(events.includes('undo'));
  assert.equal(events.includes('noteFailure'), false);
});
