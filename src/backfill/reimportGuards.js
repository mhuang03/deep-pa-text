import { SWITCH_STATES } from './databaseSwitch.js';

const GENERATION_PREFIX = 'g';
const NON_DIGITS = /\D/g;
const TIMESTAMP_DIGITS = 14;
const RESUMABLE = [SWITCH_STATES.BEFORE_SWAP, SWITCH_STATES.IN_PROGRESS];

export const buildGeneration = (now) =>
  `${GENERATION_PREFIX}${new Date(now).toISOString().replace(NON_DIGITS, '').slice(0, TIMESTAMP_DIGITS)}`;

const refusal = ({ state, reason }) => {
  if (state === SWITCH_STATES.BLOCKED) return reason;
  if (state === SWITCH_STATES.BEFORE_BACKUP) {
    return 'A previous re-import stopped before the backup was made. Move the .new file next to the database away and run again; the database itself is untouched.';
  }
  return 'A previous re-import was interrupted. Run again with --resume to finish it.';
};

export const assertRunnable = (status, resume) => {
  if (!resume) {
    if (status.state !== SWITCH_STATES.READY) throw new Error(refusal(status));
    return;
  }
  if (status.state === SWITCH_STATES.READY) throw new Error('Nothing to resume: no re-import was started.');
  if (status.state === SWITCH_STATES.BLOCKED) throw new Error(`Nothing to resume. ${status.reason}`);
  if (!RESUMABLE.includes(status.state)) throw new Error(refusal(status));
};

export const verificationFailure = (error, db) => new Error(
  `${error.message} The original database is intact. Move ${db}.old away and run again without --resume `
  + `(move ${db}.new away too).`,
);
