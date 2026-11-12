import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResponder, DELIVERY_STAGE } from '../../../src/bot/responder.js';

const REQUEST = { trigger: 'auto', persona: 'bob', target: { id: '1' }, guild: { id: 'g' }, channel: { id: 'c' }, via: { type: 'channel' } };

const NOW = 777;

const setup = ({ failCompose = null, failDeliver = null, sent = { id: 'sent', createdTimestamp: 55 }, failInsert = null, failContext = null } = {}) => {
  const events = [];
  const rows = [];
  const logs = [];
  const botMessageStore = {
    insert: (row) => {
      if (failInsert) throw failInsert;
      rows.push(row);
    },
  };
  const logger = { warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) };
  const contextBuilder = {
    forRevive: async (arg) => {
      events.push(['reviveContext', arg]);
      if (failContext) throw failContext;
      return { transcript: [], quietMs: 9, nowMs: NOW };
    },
    forReply: async (arg) => {
      events.push(['context', arg]);
      if (failContext) throw failContext;
      return { transcript: ['t'] };
    },
  };
  const composer = {
    compose: async (arg) => {
      events.push(['compose', arg]);
      if (failCompose) throw failCompose;
      return { response: 'raw', content: 'shown', gifLinks: [{ match: 'm', url: 'u' }] };
    },
  };
  const delivery = {
    deliver: async (arg) => {
      events.push(['deliver', arg]);
      if (failDeliver) throw failDeliver;
      return sent;
    },
  };
  return { responder: createResponder({ composer, delivery, contextBuilder, botMessageStore, now: () => NOW, logger }), events, rows, logs };
};

test('composes then delivers and returns the response and the sent message', async () => {
  const { responder, events } = setup();
  const result = await responder.respond(REQUEST);
  assert.deepEqual(result, { response: 'raw', message: { id: 'sent', createdTimestamp: 55 } });
  assert.deepEqual(events, [
    ['context', { channel: { id: 'c' }, target: { id: '1' } }],
    ['compose', { persona: 'bob', target: { id: '1' }, context: { transcript: ['t'] } }],
    ['deliver', {
      via: { type: 'channel' }, persona: 'bob', guild: { id: 'g' }, content: 'shown',
      gifLinks: [{ match: 'm', url: 'u' }],
    }],
  ]);
});

test('a revive builds the revive context with the injected clock and passes it to compose', async () => {
  const { responder, events } = setup();
  await responder.respond({ ...REQUEST, trigger: 'revive', target: null });
  assert.deepEqual(events[0], ['reviveContext', { channel: { id: 'c' }, nowMs: NOW }]);
  assert.deepEqual(events[1], [
    'compose', { persona: 'bob', target: null, context: { transcript: [], quietMs: 9, nowMs: NOW } },
  ]);
  assert.equal(events.some(([name]) => name === 'context'), false);
});

test('a revive context failure is logged as a warning and the revive is still composed and sent', async () => {
  const { responder, events, logs } = setup({ failContext: new Error('history down') });
  await responder.respond({ ...REQUEST, trigger: 'revive', target: null });
  assert.deepEqual(events.map(([name]) => name), ['reviveContext', 'compose', 'deliver']);
  assert.deepEqual(events[1], ['compose', { persona: 'bob', target: null, context: undefined }]);
  assert.equal(logs[0][0], 'warn');
});

test('a generation failure propagates unmarked and nothing is delivered', async () => {
  const boom = new Error('llm down');
  const { responder, events } = setup({ failCompose: boom });
  await assert.rejects(responder.respond(REQUEST), (error) => error === boom && error.stage === undefined);
  assert.deepEqual(events.map(([name]) => name), ['context', 'compose']);
});

test('a context failure propagates and nothing is composed or delivered', async () => {
  const { responder, events } = setup({ failContext: new Error('history down') });
  await assert.rejects(responder.respond(REQUEST), /history down/);
  assert.deepEqual(events, [['context', { channel: { id: 'c' }, target: { id: '1' } }]]);
});

test('a delivery failure propagates marked with the delivery stage', async () => {
  const boom = new Error('unknown message');
  const { responder } = setup({ failDeliver: boom });
  await assert.rejects(responder.respond(REQUEST), (error) => error === boom && error.stage === DELIVERY_STAGE);
  assert.equal(DELIVERY_STAGE, 'delivery');
});

test('a non-Error delivery rejection is wrapped as an Error with the stage', async () => {
  const { responder } = setup({ failDeliver: 'nope' });
  await assert.rejects(responder.respond(REQUEST), (error) => (
    error instanceof Error && error.stage === 'delivery' && error.cause === 'nope'
  ));
});

test('records the sent message after delivery with persona, raw response, timestamp, reference and trigger', async () => {
  const { responder, rows } = setup();
  await responder.respond(REQUEST);
  assert.deepEqual(rows, [{
    id: 'sent', persona: 'bob', content: 'raw', timestamp: 55, reference: '1', trigger: 'auto',
  }]);
});

test('a revive is recorded with a null reference', async () => {
  const { responder, rows } = setup();
  await responder.respond({ ...REQUEST, trigger: 'revive', target: null });
  assert.equal(rows[0].reference, null);
  assert.equal(rows[0].trigger, 'revive');
});

test('falls back to now() when the sent message has no timestamp', async () => {
  const { responder, rows } = setup({ sent: { id: 'sent' } });
  await responder.respond(REQUEST);
  assert.equal(rows[0].timestamp, NOW);
});

test('a failed delivery records nothing', async () => {
  const { responder, rows } = setup({ failDeliver: new Error('x') });
  await assert.rejects(responder.respond(REQUEST));
  assert.deepEqual(rows, []);
});

test('a sent message without an id records nothing and logs a warning', async () => {
  const { responder, rows, logs } = setup({ sent: {} });
  const result = await responder.respond(REQUEST);
  assert.equal(result.response, 'raw');
  assert.deepEqual(rows, []);
  assert.equal(logs[0][0], 'warn');
});

test('a failing store is logged as an error and the response still counts as sent', async () => {
  const boom = new Error('disk full');
  const { responder, logs } = setup({ failInsert: boom });
  const result = await responder.respond(REQUEST);
  assert.deepEqual(result.message, { id: 'sent', createdTimestamp: 55 });
  assert.equal(logs[0][0], 'error');
  assert.equal(logs[0][2], boom);
});
