import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResponder, DELIVERY_STAGE } from '../../../src/bot/responder.js';

const REQUEST = { trigger: 'auto', persona: 'bob', target: { id: '1' }, guild: { id: 'g' }, via: { type: 'channel' } };

const setup = ({ failCompose = null, failDeliver = null } = {}) => {
  const events = [];
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
      return { id: 'sent' };
    },
  };
  return { responder: createResponder({ composer, delivery, logger: {} }), events };
};

test('composes then delivers and returns the response and the sent message', async () => {
  const { responder, events } = setup();
  const result = await responder.respond(REQUEST);
  assert.deepEqual(result, { response: 'raw', message: { id: 'sent' } });
  assert.deepEqual(events, [
    ['compose', { persona: 'bob', target: { id: '1' } }],
    ['deliver', {
      via: { type: 'channel' }, persona: 'bob', guild: { id: 'g' }, content: 'shown',
      gifLinks: [{ match: 'm', url: 'u' }],
    }],
  ]);
});

test('passes a null target through for a revive', async () => {
  const { responder, events } = setup();
  await responder.respond({ ...REQUEST, trigger: 'revive', target: null });
  assert.deepEqual(events[0][1], { persona: 'bob', target: null });
});

test('a generation failure propagates unmarked and nothing is delivered', async () => {
  const boom = new Error('llm down');
  const { responder, events } = setup({ failCompose: boom });
  await assert.rejects(responder.respond(REQUEST), (error) => error === boom && error.stage === undefined);
  assert.equal(events.length, 1);
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
