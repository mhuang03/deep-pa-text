import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRunnable, buildGeneration, verificationFailure } from '../../../src/backfill/reimportGuards.js';
import { SWITCH_STATES } from '../../../src/backfill/switchState.js';

const status = (state, reason = null) => ({ state, reason });

test('buildGeneration is g plus the UTC timestamp', () => {
  assert.equal(buildGeneration(Date.parse('2026-01-02T03:04:05Z')), 'g20260102030405');
});

test('a fresh run is allowed only from the ready state', () => {
  assert.doesNotThrow(() => assertRunnable(status(SWITCH_STATES.READY), false));
  assert.throws(() => assertRunnable(status(SWITCH_STATES.BLOCKED, 'moved away'), false), /moved away/);
  assert.throws(() => assertRunnable(status(SWITCH_STATES.BEFORE_BACKUP), false), /stopped before the backup/);
  assert.throws(() => assertRunnable(status(SWITCH_STATES.IN_PROGRESS), false), /--resume/);
});

test('a resume needs an interrupted run', () => {
  assert.doesNotThrow(() => assertRunnable(status(SWITCH_STATES.BEFORE_SWAP), true));
  assert.doesNotThrow(() => assertRunnable(status(SWITCH_STATES.IN_PROGRESS), true));
  assert.throws(() => assertRunnable(status(SWITCH_STATES.READY), true), /Nothing to resume: no re-import/);
  assert.throws(() => assertRunnable(status(SWITCH_STATES.BLOCKED, 'blocked here'), true), /Nothing to resume. blocked here/);
  assert.throws(() => assertRunnable(status(SWITCH_STATES.BEFORE_BACKUP), true), /stopped before the backup/);
});

test('a verification failure says the original is intact and names the files to move', () => {
  const error = verificationFailure(new Error('not identical'), 'messages.db');
  assert.match(error.message, /not identical/);
  assert.match(error.message, /original database is intact/);
  assert.match(error.message, /messages\.db\.old/);
  assert.match(error.message, /messages\.db\.new/);
});
