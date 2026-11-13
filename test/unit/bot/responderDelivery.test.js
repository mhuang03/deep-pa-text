import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPartDelivery } from '../../../src/bot/responderDelivery.js';
import { loadConfig } from '../../../src/config.js';

const config = loadConfig({});
const channel = { id: 'c' };

const setup = ({ failAt = null } = {}) => {
  const delivered = [];
  const recorded = [];
  const sleeps = [];
  const errors = [];
  const typing = { pulses: 0, pulse() { this.pulses += 1; }, stop() {} };
  const parts = createPartDelivery({
    delivery: {
      deliver: async (arg) => {
        if (failAt === delivered.length) throw new Error('send failed');
        delivered.push(arg);
        return { id: `m${delivered.length}` };
      },
    },
    record: (arg) => recorded.push(arg),
    clock: { sleep: async (ms) => sleeps.push(ms) },
    config,
    logger: { error: (...a) => errors.push(a) },
  });
  return { parts, delivered, recorded, sleeps, errors, typing };
};

const request = (overrides = {}) => ({
  trigger: 'auto', persona: 'bob', guild: { id: 'g' }, channel, target: { id: 't' }, via: { type: 'reply' }, ...overrides,
});
const part = (text) => ({ text, content: `shown ${text}`, gifLinks: [] });

test('delivers the first part through the request via and records it', async () => {
  const { parts, delivered, recorded, typing } = setup();
  const messages = await parts.deliverAll(request(), { parts: [part('one')], typing });
  assert.deepEqual(messages, [{ id: 'm1' }]);
  assert.equal(delivered[0].via.type, 'reply');
  assert.equal(delivered[0].content, 'shown one');
  assert.deepEqual(recorded, [{
    message: { id: 'm1' }, text: 'one', persona: 'bob', target: { id: 't' }, trigger: 'auto', conversation: undefined,
  }]);
});

test('later parts go to the channel after a pause and a typing pulse', async () => {
  const { parts, delivered, sleeps, typing } = setup();
  const messages = await parts.deliverAll(request(), { parts: [part('one'), part('two')], typing });
  assert.equal(messages.length, 2);
  assert.deepEqual(delivered[1].via, { type: 'channel', channel });
  assert.equal(sleeps.length, 1);
  assert.equal(typing.pulses, 1);
});

test('later parts of a command reply go out as follow-ups', async () => {
  const { parts, delivered, typing } = setup();
  const interaction = { id: 'i' };
  await parts.deliverAll(
    request({ trigger: 'command', via: { type: 'interaction', interaction } }), { parts: [part('one'), part('two')], typing },
  );
  assert.deepEqual(delivered[1].via, { type: 'followUp', interaction });
});

test('onDelivered fires after the first part only', async () => {
  const { parts, typing } = setup();
  let fired = 0;
  await parts.deliverAll(request({ onDelivered: () => { fired += 1; } }), { parts: [part('one'), part('two')], typing });
  assert.equal(fired, 1);
});

test('a failed first part throws a delivery-stage error carrying persona and trigger', async () => {
  const { parts, typing } = setup({ failAt: 0 });
  await assert.rejects(parts.deliverAll(request(), { parts: [part('one')], typing }), (error) => {
    assert.equal(error.stage, 'delivery');
    assert.equal(error.persona, 'bob');
    assert.equal(error.trigger, 'auto');
    return true;
  });
});

test('a failed later part is logged, ends the burst and keeps what was sent', async () => {
  const { parts, errors, typing } = setup({ failAt: 1 });
  const messages = await parts.deliverAll(request(), { parts: [part('one'), part('two'), part('three')], typing });
  assert.equal(messages.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /later part of the burst/);
});
