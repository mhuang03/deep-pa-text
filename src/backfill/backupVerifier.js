import { createHash } from 'node:crypto';

const HASH_CHUNK_BYTES = 1024 * 1024;
const TABLE_QUERY = "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?";

// Streamed in fixed chunks so a large database is never read into memory at once.
const sha256 = (fs, path) => {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
  const fd = fs.openSync(path, 'r');
  try {
    let read = fs.readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null);
    while (read > 0) {
      hash.update(buffer.subarray(0, read));
      read = fs.readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
};

const isSameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

const assertEqualContent = (fs, db, backupPath) => {
  const original = fs.statSync(db);
  const backup = fs.statSync(backupPath);
  if (isSameFile(original, backup)) return;
  if (original.size !== backup.size || sha256(fs, db) !== sha256(fs, backupPath)) {
    throw new Error(`The backup ${backupPath} is not identical to ${db} (it may be truncated); it was not trusted.`);
  }
};

const assertOpensWithMessages = ({ openDatabase }, backupPath) => {
  const handle = openDatabase(backupPath, { readOnly: true });
  try {
    if (handle.prepare(TABLE_QUERY).get('messages') === undefined) {
      throw new Error(`The backup ${backupPath} has no messages table; it was not trusted.`);
    }
  } finally {
    handle.close();
  }
};

// Equality with the original (same inode, or same size and SHA-256), then a read-only open of the backup.
export const verifyBackupFile = (deps, db, backupPath) => {
  assertEqualContent(deps.fs, db, backupPath);
  assertOpensWithMessages(deps, backupPath);
};
