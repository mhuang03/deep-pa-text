import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, formatTimestamp } from '../../src/logger.js';

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
  assert.deepEqual(sink.calls, [['log', ['a', 1]], ['warn', ['b']], ['error', ['c', { x: 1 }]]]);
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
