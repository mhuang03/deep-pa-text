import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyBackupFile } from '../../../src/backfill/backupVerifier.js';
import { openDatabase } from '../../../src/storage/database.js';

const setup = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'messages.db');
  openDatabase(db).close();
  return { dir, db };
};

test('accepts a hard link to the original', (t) => {
  const { dir, db } = setup(t);
  const link = path.join(dir, 'link');
  fs.linkSync(db, link);
  assert.doesNotThrow(() => verifyBackupFile({ fs, openDatabase }, db, link));
});

test('accepts an identical copy and rejects one that differs in content', (t) => {
  const { dir, db } = setup(t);
  const copy = path.join(dir, 'copy');
  fs.copyFileSync(db, copy);
  assert.doesNotThrow(() => verifyBackupFile({ fs, openDatabase }, db, copy));
  const bytes = fs.readFileSync(copy);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(copy, bytes);
  assert.throws(() => verifyBackupFile({ fs, openDatabase }, db, copy), /not identical/);
});

test('rejects a truncated copy', (t) => {
  const { dir, db } = setup(t);
  const copy = path.join(dir, 'copy');
  fs.writeFileSync(copy, fs.readFileSync(db).subarray(0, 100));
  assert.throws(() => verifyBackupFile({ fs, openDatabase }, db, copy), /not identical/);
});

test('rejects a backup without a messages table', (t) => {
  const { dir, db } = setup(t);
  const fakeFs = { ...fs, statSync: () => ({ dev: 1, ino: 1 }) };
  const empty = path.join(dir, 'empty.db');
  fs.writeFileSync(empty, '');
  assert.throws(() => verifyBackupFile({ fs: fakeFs, openDatabase }, db, empty), /no messages table/);
});
