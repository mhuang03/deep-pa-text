import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = (file) => new URL(`../../../${file}`, import.meta.url).pathname;

const makeDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpt-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const run = (script, dir, env = {}, args = []) => spawnSync(process.execPath, ['--no-warnings', root(script), ...args], {
  cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 20000,
});

const oneLine = (result) => {
  const lines = result.stderr.trim().split('\n');
  assert.equal(lines.length, 1, result.stderr);
  assert.doesNotMatch(result.stderr, /\bat .*\.js/, 'no stack');
  return lines[0];
};

test('main.js with missing variables exits 1 with one line listing all of them', (t) => {
  const result = run('src/main.js', makeDir(t));
  assert.equal(result.status, 1);
  assert.equal(oneLine(result),
    'Missing required environment variables: DISCORD_BOT_TOKEN, DEEPSEEK_API_KEY, OPENAI_API_KEY. Set them in .env or the environment.');
});

test('main.js with only OPENAI_API_KEY set fails naming DEEPSEEK_API_KEY and needs no .env file', (t) => {
  const result = run('src/main.js', makeDir(t), { DISCORD_BOT_TOKEN: 't', OPENAI_API_KEY: 'o' });
  assert.equal(result.status, 1);
  assert.match(oneLine(result), /: DEEPSEEK_API_KEY\./);
});

test('main.js with an unreadable users.json exits 1 with one line naming the file', (t) => {
  const env = { DISCORD_BOT_TOKEN: 't', OPENAI_API_KEY: 'o', DEEPSEEK_API_KEY: 'd' };
  const result = run('src/main.js', makeDir(t), env);
  assert.equal(result.status, 1);
  assert.match(oneLine(result), /data\/users\.json/);
});

test('main.js with a malformed variable exits 1 with the one-line message', (t) => {
  const result = run('src/main.js', makeDir(t), { BURSTS: '0' });
  assert.equal(result.status, 1);
  assert.equal(oneLine(result), 'BURSTS must be "true" or "false", got "0"');
});

test('the other scripts check their own requirements', (t) => {
  const dir = makeDir(t);
  const cases = [
    ['scripts/registerCommands.js', /DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID/],
    ['scripts/backfill.js', /DISCORD_BOT_TOKEN, OPENAI_API_KEY/],
    ['scripts/reimport.js', /DISCORD_BOT_TOKEN, OPENAI_API_KEY/],
  ];
  cases.forEach(([script, pattern]) => {
    const result = run(script, dir, {}, []);
    assert.equal(result.status, 1, `${script}: ${result.stderr}`);
    assert.match(result.stderr, pattern);
  });
});

test('gifSmoke.js with no GIF keys exits 1', (t) => {
  const result = run('scripts/gifSmoke.js', makeDir(t));
  assert.equal(result.status, 1);
  assert.match(oneLine(result), /at least one of KLIPY_API_KEY, GIPHY_API_KEY, HUMOR_API_KEY/);
});

test('a .env directory is reported as a config error naming .env', (t) => {
  const dir = makeDir(t);
  fs.mkdirSync(path.join(dir, '.env'));
  const result = run('src/main.js', dir);
  assert.equal(result.status, 1);
  assert.match(oneLine(result), /\.env/);
});
