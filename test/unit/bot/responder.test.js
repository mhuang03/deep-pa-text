import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResponder, DELIVERY_STAGE } from '../../../src/bot/responder.js';
import { loadConfig } from '../../../src/config.js';

const channelStub = { id: 'c', sendTyping: async () => {} };
const REQUEST = { trigger: 'auto', persona: 'bob', target: { id: '1' }, guild: { id: 'g' }, channel: channelStub, via: { type: 'channel' } };

const NOW = 777;

const FIRST_PART = { text: 'raw', content: 'shown', gifLinks: [{ match: 'm', url: 'u' }] };

const setup = ({
  failCompose = null, failDeliver = null, sent = { id: 'sent', createdTimestamp: 55 }, failInsert = null,
  failContext = null, parts = [FIRST_PART], failDeliverAt = null, configOverrides = {},
} = {}) => {
  const events = [];
  const rows = [];
  const logs = [];
  const timers = [];
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
      return { response: parts.map((part) => part.text).join('\n<split>\n'), parts };
    },
  };
  const delivery = {
    deliver: async (arg) => {
      events.push(['deliver', arg]);
      if (failDeliver) throw failDeliver;
      const index = events.filter(([name]) => name === 'deliver').length;
      if (failDeliverAt === index) throw new Error('later send failed');
      return index === 1 ? sent : { id: `sent-${index}`, createdTimestamp: 55 + index };
    },
  };
  const clock = {
    now: () => NOW,
    sleep: async (ms) => events.push(['sleep', ms]),
    setInterval: (fn, ms) => {
      timers.push(['setInterval', ms]);
      return 'handle';
    },
    clearInterval: (handle) => timers.push(['clearInterval', handle]),
  };
  const config = { ...loadConfig({}), ...configOverrides };
  const responder = createResponder({ composer, delivery, contextBuilder, botMessageStore, clock, config, logger });
  return { responder, events, rows, logs, timers };
};

test('composes then delivers and returns the response and the sent message', async () => {
  const { responder, events } = setup();
  const result = await responder.respond(REQUEST);
  assert.deepEqual(result, { response: 'raw', messages: [{ id: 'sent', createdTimestamp: 55 }] });
  assert.deepEqual(events, [
    ['context', { channel: channelStub, target: { id: '1' } }],
    ['compose', { persona: 'bob', target: { id: '1' }, context: { transcript: ['t'] } }],
    ['deliver', {
      via: { type: 'channel' }, persona: 'bob', guild: { id: 'g' }, channel: channelStub, content: 'shown',
      gifLinks: [{ match: 'm', url: 'u' }],
    }],
  ]);
});

test('a revive builds the revive context with the injected clock and passes it to compose', async () => {
  const { responder, events } = setup();
  await responder.respond({ ...REQUEST, trigger: 'revive', target: null });
  assert.deepEqual(events[0], ['reviveContext', { channel: channelStub, nowMs: NOW }]);
  assert.deepEqual(events[1], [
    'compose', { persona: 'bob', target: null, context: { transcript: [], quietMs: 9, nowMs: NOW } },
  ]);
  assert.equal(events.some(([name]) => name === 'context'), false);
});

test('a revive context failure is logged as a warning and the revive is still composed and sent', async () => {
  const { responder, events, logs } = setup({ failContext: new Error('history down') });
  await responder.respond({ ...REQUEST, trigger: 'revive', target: null });
  assert.deepEqual(events.map(([name]) => name), ['reviveContext', 'compose', 'deliver']);
  assert.deepEqual(events[1], ['compose', { persona: 'bob', target: null, context: {} }]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'warn');
});

test('a generation failure is rethrown as a new error with the generation stage, persona and trigger', async () => {
  const boom = new Error('llm down');
  const { responder, events } = setup({ failCompose: boom });
  await assert.rejects(responder.respond(REQUEST), (error) => (
    error !== boom && error.message === 'llm down' && error.cause === boom
    && error.stage === 'generation' && error.persona === 'bob' && error.trigger === 'auto'
  ));
  assert.equal(boom.stage, undefined, 'the caught error is not mutated');
  assert.deepEqual(events.map(([name]) => name), ['context', 'compose']);
});

test('a reply context failure is a warning: the reply is composed without a transcript and sent', async () => {
  const { responder, events, logs } = setup({ failContext: new Error('history down') });
  await responder.respond(REQUEST);
  assert.deepEqual(events.map(([name]) => name), ['context', 'compose', 'deliver']);
  assert.deepEqual(events[1], ['compose', { persona: 'bob', target: { id: '1' }, context: { transcript: [] } }]);
  assert.deepEqual(logs.map(([level]) => level), ['warn']);
});

test('a delivery failure is rethrown as a new error with the delivery stage, persona and trigger', async () => {
  const boom = new Error('unknown message');
  const { responder } = setup({ failDeliver: boom });
  await assert.rejects(responder.respond(REQUEST), (error) => (
    error !== boom && error.cause === boom && error.stage === DELIVERY_STAGE
    && error.persona === 'bob' && error.trigger === 'auto'
  ));
  assert.equal(boom.stage, undefined);
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
  assert.deepEqual(result.messages, [{ id: 'sent', createdTimestamp: 55 }]);
  assert.equal(logs[0][0], 'error');
  assert.equal(logs[0][2], boom);
});

test('a chain request skips the history fetch and composes with the chain as context', async () => {
  const { responder, events } = setup();
  const chain = { persona: 'bob', turns: [], botTurns: 1 };
  await responder.respond({ ...REQUEST, trigger: 'chain', chain });
  assert.deepEqual(events.map(([name]) => name), ['compose', 'deliver']);
  assert.deepEqual(events[0], ['compose', { persona: 'bob', target: { id: '1' }, context: { chain } }]);
});

test('a chain reply is recorded with the incoming message as its reference and the chain trigger', async () => {
  const { responder, rows } = setup();
  await responder.respond({ ...REQUEST, trigger: 'chain', chain: { turns: [] } });
  assert.equal(rows[0].trigger, 'chain');
  assert.equal(rows[0].reference, '1');
});

const BURST = [
  { text: 'one', content: 'one', gifLinks: [] },
  { text: 'two', content: 'two', gifLinks: [] },
  { text: '<gif! cat>', content: '', gifLinks: [{ match: '<gif! cat>', url: 'g' }] },
];

const deliveries = (events) => events.filter(([name]) => name === 'deliver').map(([, arg]) => arg);

test('part 1 goes through the request via and later parts through the channel, each after a sleep', async () => {
  const { responder, events } = setup({ parts: BURST });
  const via = { type: 'reply', message: { id: 'm' } };
  const result = await responder.respond({ ...REQUEST, via });
  const sent = deliveries(events);
  assert.deepEqual(sent.map((d) => d.via), [via, { type: 'channel', channel: channelStub }, { type: 'channel', channel: channelStub }]);
  assert.deepEqual(sent.map((d) => d.content), ['one', 'two', '']);
  assert.deepEqual(events.filter(([name]) => name === 'sleep'), [['sleep', 800], ['sleep', 800]]);
  assert.deepEqual(events.map(([name]) => name).slice(-5), ['deliver', 'sleep', 'deliver', 'sleep', 'deliver']);
  assert.equal(result.messages.length, 3);
  assert.equal(result.response, 'one\n<split>\ntwo\n<split>\n<gif! cat>');
});

test('every delivered part is recorded with its own text, the persona, trigger and reference', async () => {
  const { responder, rows } = setup({ parts: BURST });
  await responder.respond(REQUEST);
  assert.deepEqual(rows.map((row) => [row.id, row.content, row.persona, row.trigger, row.reference]), [
    ['sent', 'one', 'bob', 'auto', '1'],
    ['sent-2', 'two', 'bob', 'auto', '1'],
    ['sent-3', '<gif! cat>', 'bob', 'auto', '1'],
  ]);
});

test('a command delivers later parts as follow-ups and never types', async () => {
  const { responder, events, timers } = setup({ parts: BURST });
  const interaction = { id: 'i' };
  await responder.respond({ ...REQUEST, trigger: 'command', via: { type: 'interaction', interaction } });
  assert.deepEqual(deliveries(events).slice(1).map((d) => d.via), [
    { type: 'followUp', interaction }, { type: 'followUp', interaction },
  ]);
  assert.deepEqual(timers, []);
});

test('onDelivered is called once, right after part 1 and before the first sleep', async () => {
  const { responder, events } = setup({ parts: BURST });
  await responder.respond({ ...REQUEST, onDelivered: () => events.push(['onDelivered']) });
  assert.deepEqual(events.map(([name]) => name).slice(-6), [
    'deliver', 'onDelivered', 'sleep', 'deliver', 'sleep', 'deliver',
  ]);
  assert.equal(events.filter(([name]) => name === 'onDelivered').length, 1);
});

test('when part 1 fails onDelivered is not called and respond rejects', async () => {
  const { responder, events } = setup({ parts: BURST, failDeliver: new Error('x') });
  let called = false;
  await assert.rejects(responder.respond({ ...REQUEST, onDelivered: () => { called = true; } }));
  assert.equal(called, false);
  assert.equal(deliveries(events).length, 1);
});

test('a failing later part is logged, the rest are skipped and respond resolves', async () => {
  const { responder, events, rows, logs } = setup({ parts: BURST, failDeliverAt: 2 });
  const result = await responder.respond(REQUEST);
  assert.equal(deliveries(events).length, 2);
  assert.equal(result.messages.length, 1);
  assert.deepEqual(rows.map((row) => row.content), ['one']);
  assert.equal(logs.filter(([level]) => level === 'error').length, 1);
});

test('the sleep before a later part follows its length within the configured bounds', async () => {
  const long = { text: 'x'.repeat(200), content: 'x', gifLinks: [] };
  const { responder, events } = setup({ parts: [BURST[0], long] });
  await responder.respond(REQUEST);
  assert.deepEqual(events.find(([name]) => name === 'sleep'), ['sleep', 4000]);
});

test('typing starts before the context, refreshes on an interval, pulses before each sleep and stops', async () => {
  const order = [];
  const channel = { id: 'c', sendTyping: async () => order.push('typing') };
  const { responder, events, timers } = setup({ parts: BURST });
  events.push = ((push) => (...entries) => {
    entries.forEach(([name]) => order.push(name));
    return push.apply(events, entries);
  })(events.push);
  await responder.respond({ ...REQUEST, channel });
  assert.deepEqual(order.slice(0, 3), ['typing', 'context', 'compose']);
  assert.equal(order.filter((name) => name === 'typing').length, 3);
  assert.deepEqual(timers, [['setInterval', 8000], ['clearInterval', 'handle']]);
});

test('typing is stopped when generation fails and skipped when disabled', async () => {
  const failing = setup({ failCompose: new Error('llm') });
  await assert.rejects(failing.responder.respond(REQUEST));
  assert.deepEqual(failing.timers.at(-1), ['clearInterval', 'handle']);
  const typing = { ...loadConfig({}).typing, enabled: false };
  const off = setup({ configOverrides: { typing } });
  await off.responder.respond(REQUEST);
  assert.deepEqual(off.timers, []);
});
