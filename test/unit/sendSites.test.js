import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
// Later specs extend this list; every other module must go through the delivery adapter.
const ALLOWED = [
  'src/discord/delivery.js', 'src/discord/webhookDelivery.js', 'src/bot/handlers/replyCommand.js',
];
const SEND_CALL = /\.(reply|send|editReply|followUp)\(/;

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const listJsFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

const sources = listJsFiles(path.join(ROOT, 'src'))
  .map((file) => ({ file: path.relative(ROOT, file), text: stripComments(fs.readFileSync(file, 'utf8')) }));

test('only the allowlisted modules call reply, send, editReply or followUp', () => {
  const offenders = sources
    .filter(({ file, text }) => !ALLOWED.includes(file) && SEND_CALL.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test('the allowlisted modules exist and do send', () => {
  ALLOWED.forEach((allowed) => {
    const source = sources.find(({ file }) => file === allowed);
    assert.ok(source, allowed);
    assert.match(source.text, SEND_CALL);
  });
});

test('comments are ignored by the scan', () => {
  assert.equal(SEND_CALL.test(stripComments('// message.reply(x)\n/* a.send(y) */ const z = 1;')), false);
  assert.equal(SEND_CALL.test(stripComments('message.reply(x);')), true);
});
