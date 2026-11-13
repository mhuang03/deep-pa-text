import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcStamp } from '../../../src/util/utcStamp.js';

test('formats a time as UTC YYYYMMDDHHMMSS', () => {
  assert.equal(utcStamp(Date.parse('2026-11-12T18:05:09.999Z')), '20261112180509');
  assert.equal(utcStamp(0), '19700101000000');
});
