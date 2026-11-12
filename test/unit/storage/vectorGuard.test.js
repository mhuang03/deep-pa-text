import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectorGuard } from '../../../src/storage/vectorGuard.js';
import { createManualClock, flush, CHROMA_LIMITS } from '../../support/clocks.js';

const config = { chroma: CHROMA_LIMITS };

test('exposes the three configured limits', () => {
  const { limits } = createVectorGuard({ config, clock: createManualClock() });
  assert.deepEqual(limits, { interactive: 30000, connect: 10000, batch: 120000 });
});

test('returns the work result and arms a timer of the requested length', async () => {
  const clock = createManualClock();
  const { timed } = createVectorGuard({ config, clock });
  assert.equal(await timed('get', 777, async () => 'ok'), 'ok');
  assert.deepEqual(clock.scheduled, [777]);
  assert.equal(clock.pendingCount(), 0);
});

test('a failure leaves as a tagged copy and the original error is not mutated', async () => {
  const { timed } = createVectorGuard({ config, clock: createManualClock() });
  const original = new Error('chroma down');
  await assert.rejects(timed('get', 5, async () => { throw original; }), (error) => {
    assert.equal(error.isVectorError, true);
    assert.equal(error.cause, original);
    return true;
  });
  assert.equal('isVectorError' in original, false);
});

test('a hung call times out with a tagged error naming the method', async () => {
  const clock = createManualClock();
  const { timed } = createVectorGuard({ config, clock });
  const pending = timed('query', 50, () => new Promise(() => {}));
  await flush();
  clock.fireNext();
  await assert.rejects(pending, (error) => error.isVectorError === true && /chroma query timed out after 50 ms/.test(error.message));
});

test('a synchronous throw inside the work is also tagged', async () => {
  const { timed } = createVectorGuard({ config, clock: createManualClock() });
  await assert.rejects(timed('x', 5, () => { throw new Error('sync'); }), (error) => error.isVectorError === true);
});
