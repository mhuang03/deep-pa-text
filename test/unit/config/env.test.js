import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvIfPresent } from '../../../src/config/env.js';
import { isConfigError } from '../../../src/config/errors.js';

test('loads the file when it exists', () => {
  const loaded = [];
  const result = loadEnvIfPresent('.env', { existsSync: () => true, loadEnvFile: (p) => loaded.push(p) });
  assert.equal(result, true);
  assert.deepEqual(loaded, ['.env']);
});

test('does nothing when the file is absent', () => {
  const result = loadEnvIfPresent('.env', {
    existsSync: () => false,
    loadEnvFile: () => assert.fail('must not load'),
  });
  assert.equal(result, false);
});

test('a file that cannot be loaded is a config error naming it', () => {
  const failing = () => loadEnvIfPresent('.env', {
    existsSync: () => true, loadEnvFile: () => { throw new Error('boom'); },
  });
  assert.throws(failing, (e) => isConfigError(e) && e.message.includes('.env') && e.message.includes('boom'));
});

test('a directory named .env is a config error with the real loader', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, '.env');
  fs.mkdirSync(target);
  assert.throws(() => loadEnvIfPresent(target), (e) => isConfigError(e) && e.message.includes('.env'));
});

test('a missing real file is fine', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(loadEnvIfPresent(path.join(dir, '.env')), false);
});
