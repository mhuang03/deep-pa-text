import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendDetached } from '../../../src/bot/detachedSend.js';

const setup = () => {
  const errors = [];
  return { errors, logger: { error: (...args) => errors.push(args) } };
};

test('returns without awaiting the send and without logging on success', async () => {
  const { errors, logger } = setup();
  await sendDetached({ send: async () => 'sent', logger, errorLabel: 'label:' });
  assert.deepEqual(errors, []);
});

test('logs a rejected send with the label and the error', async () => {
  const { errors, logger } = setup();
  const boom = new Error('send failed');
  await sendDetached({ send: () => Promise.reject(boom), logger, errorLabel: 'label:' });
  assert.deepEqual(errors, [['label:', boom]]);
});

test('accepts a send that returns a plain value', async () => {
  const { errors, logger } = setup();
  await sendDetached({ send: () => 42, logger, errorLabel: 'label:' });
  assert.deepEqual(errors, []);
});

test('lets a synchronous throw propagate to the caller', () => {
  const { errors, logger } = setup();
  const boom = new Error('sync');
  assert.throws(() => sendDetached({ send: () => { throw boom; }, logger, errorLabel: 'l' }), boom);
  assert.deepEqual(errors, []);
});

test('starts the send immediately', () => {
  const { logger } = setup();
  let started = false;
  sendDetached({ send: () => { started = true; return new Promise(() => {}); }, logger, errorLabel: 'l' });
  assert.equal(started, true);
});
