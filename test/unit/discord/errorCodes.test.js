import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNKNOWN_MEMBER_CODE, UNKNOWN_USER_CODE, UNKNOWN_WEBHOOK_CODE, NOT_FOUND_STATUS,
} from '../../../src/discord/errorCodes.js';

test('names the Discord error codes and the HTTP status the bot reacts to', () => {
  assert.deepEqual(
    [UNKNOWN_MEMBER_CODE, UNKNOWN_USER_CODE, UNKNOWN_WEBHOOK_CODE, NOT_FOUND_STATUS],
    [10007, 10013, 10015, 404],
  );
});
