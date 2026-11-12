import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectSwitch } from '../../../src/backfill/switchInspect.js';

const DB = '/x/messages.db';

const setup = ({ files = [DB], meta = null } = {}) => {
  const present = new Set(files);
  const opened = [];
  const ctx = {
    fs: { existsSync: (file) => present.has(file) },
    openDatabase: (path, options) => {
      opened.push([path, options]);
      return {
        prepare: () => ({ get: () => (meta ? { found: 1 } : undefined) }),
        close: () => {},
      };
    },
    createMetaStore: () => ({ get: (key) => meta?.[key] ?? null }),
  };
  return { ctx, opened };
};

test('ready for a lone database', () => {
  assert.deepEqual(inspectSwitch(setup().ctx, DB), { state: 'ready', reason: null });
});

test('blocked when the database does not exist', () => {
  const result = inspectSwitch(setup({ files: [] }).ctx, DB);
  assert.equal(result.state, 'blocked');
  assert.match(result.reason, /does not exist/);
});

test('blocked by a partial backup and by journal files', () => {
  assert.match(inspectSwitch(setup({ files: [DB, `${DB}.old.tmp`] }).ctx, DB).reason, /incomplete backup/);
  const journal = inspectSwitch(setup({ files: [DB, `${DB}-wal`] }).ctx, DB);
  assert.equal(journal.state, 'blocked');
  assert.match(journal.reason, /-wal exists/);
});

test('a new file without a backup was interrupted before the backup', () => {
  assert.equal(inspectSwitch(setup({ files: [DB, `${DB}.new`] }).ctx, DB).state, 'interrupted-before-backup');
});

test('a new file with a backup was interrupted before the swap', () => {
  assert.equal(inspectSwitch(setup({ files: [DB, `${DB}.new`, `${DB}.old`] }).ctx, DB).state, 'interrupted-before-swap');
});

test('a backup next to a started but unfinished database is in progress', () => {
  const { ctx, opened } = setup({ files: [DB, `${DB}.old`], meta: { reimport_started_at: '5' } });
  assert.equal(inspectSwitch(ctx, DB).state, 'in-progress');
  assert.deepEqual(opened, [[DB, { readOnly: true }]]);
});

test('a backup next to a finished or ordinary database blocks', () => {
  const finished = setup({ files: [DB, `${DB}.old`], meta: { reimport_started_at: '5', reimport_completed_at: '9' } });
  assert.equal(inspectSwitch(finished.ctx, DB).state, 'blocked');
  assert.equal(inspectSwitch(setup({ files: [DB, `${DB}.old`] }).ctx, DB).state, 'blocked');
});
