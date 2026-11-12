import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SWITCH_STATES, switchPaths, STARTED_KEY, COMPLETED_KEY, GENERATION_KEY } from '../../../src/backfill/switchState.js';

test('switchPaths names every file next to the database', () => {
  assert.deepEqual(switchPaths('/x/messages.db'), {
    db: '/x/messages.db',
    fresh: '/x/messages.db.new',
    backup: '/x/messages.db.old',
    partial: '/x/messages.db.old.tmp',
    journals: ['/x/messages.db-journal', '/x/messages.db-wal', '/x/messages.db-shm'],
  });
});

test('the states and meta keys are fixed strings', () => {
  assert.deepEqual(Object.values(SWITCH_STATES).sort(), [
    'blocked', 'in-progress', 'interrupted-before-backup', 'interrupted-before-swap', 'ready',
  ]);
  assert.equal(Object.isFrozen(SWITCH_STATES), true);
  assert.deepEqual([STARTED_KEY, COMPLETED_KEY, GENERATION_KEY], ['reimport_started_at', 'reimport_completed_at', 'chroma_generation']);
});
