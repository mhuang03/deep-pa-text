import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, formatError, formatTimestamp } from '../../src/logger.js';

const createSink = () => {
  const calls = [];
  return {
    calls,
    log: (...args) => calls.push(['log', args]),
    warn: (...args) => calls.push(['warn', args]),
    error: (...args) => calls.push(['error', args]),
  };
};

test('forwards info, warn and error to the matching sink methods', () => {
  const sink = createSink();
  const logger = createLogger(sink);
  logger.info('a', 1);
  logger.warn('b');
  logger.error('c', { x: 1 });
  assert.deepEqual(sink.calls, [['log', ['a', 1]], ['warn', ['b']], ['error', ['c', '{ x: 1 }']]]);
});

test('defaults to the console as sink', () => {
  const logger = createLogger();
  assert.deepEqual(Object.keys(logger).sort(), ['error', 'info', 'warn']);
});

test('formatTimestamp equals the legacy toLocaleString expression', () => {
  const ms = Date.parse('2026-11-12T18:00:00Z');
  const legacy = new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago' });
  assert.equal(formatTimestamp(ms, { locale: 'en-US', timeZone: 'America/Chicago' }), legacy);
  assert.equal(legacy, '11/12/2026, 12:00:00 PM');
});

test('formatTimestamp honours the locale and time zone', () => {
  const ms = Date.parse('2026-07-01T12:00:00Z');
  assert.equal(formatTimestamp(ms, { locale: 'en-US', timeZone: 'UTC' }), '7/1/2026, 12:00:00 PM');
  assert.equal(formatTimestamp(ms, { locale: 'en-US', timeZone: 'America/Chicago' }), '7/1/2026, 7:00:00 AM');
});

const KEY = 'sk-test-0123456789';

test('an Error argument is rendered as text and never passed through as an object', () => {
  const sink = createSink();
  const error = Object.assign(new Error('boom'), { url: 'https://discord.com/api/v10/webhooks/1/SECRET', code: 50013, status: 403 });
  createLogger(sink).error('failed:', error);
  const [, [label, text]] = sink.calls[0];
  assert.equal(label, 'failed:');
  assert.equal(typeof text, 'string');
  assert.match(text, /Error: boom/);
  assert.match(text, / \[code=50013 status=403\]/);
  assert.doesNotMatch(text, /discord\.com/);
});

test('secrets, their URL-encoded form and webhook paths are redacted from every string', () => {
  const sink = createSink();
  const secret = 'abc/def+ghi123';
  const logger = createLogger(sink, { secrets: [KEY, secret, ''] });
  logger.warn(`key ${KEY} and ${encodeURIComponent(secret)}`, new Error(`GET /search?key=${KEY}`));
  logger.error('https://discord.com/api/v10/webhooks/1/SECRET/extra', { url: `https://x/?k=${KEY}` });
  const text = JSON.stringify(sink.calls);
  assert.doesNotMatch(text, /sk-test|SECRET|abc%2Fdef/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /webhooks\/1\/\[redacted\]/);
});

test('plain objects are inspected to depth 1 and redacted', () => {
  const sink = createSink();
  createLogger(sink, { secrets: [KEY] }).info({ a: { b: { c: { d: 1 } } }, key: KEY });
  const [, [text]] = sink.calls[0];
  assert.match(text, /a: \{ b: \[Object\] \}/);
  assert.doesNotMatch(text, /sk-test/);
});

test('there is no debug method', () => {
  assert.equal('debug' in createLogger(createSink()), false);
});

test('formatError of a non-Error is its string form', () => {
  assert.equal(formatError('nope'), 'nope');
  assert.equal(formatError(42), '42');
});

test('formatError appends the cause chain, at most three levels', () => {
  const chain = new Error('top', { cause: new Error('one', { cause: new Error('two', { cause: new Error('three', { cause: new Error('four') }) }) }) });
  const text = formatError(chain);
  assert.equal((text.match(/caused by: /g) ?? []).length, 3);
  assert.match(text, /caused by: .*one[\s\S]*caused by: .*two[\s\S]*caused by: .*three/);
  assert.doesNotMatch(text, /four/);
});

test('formatError falls back to name and message without a stack and shows a non-Error cause', () => {
  const error = new Error('plain', { cause: 'text cause' });
  error.stack = undefined;
  assert.equal(formatError(error), 'Error: plain\n  caused by: text cause');
});
