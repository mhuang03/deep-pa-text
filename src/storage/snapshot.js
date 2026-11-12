import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backup } from 'node:sqlite';
import { openDatabase } from './database.js';

const SNAPSHOT_PREFIX = 'dpt-snapshot-';
const SNAPSHOT_FILE = 'messages.db';
const VERSION_MARKER = { table: 'messages', column: 'deleted_at' };

const isCurrent = (db) =>
  db.prepare(`PRAGMA table_info(${VERSION_MARKER.table})`).all()
    .some((row) => row.name === VERSION_MARKER.column);

// Opens a database read-only for queries written against the current schema. A database that
// predates the schema is copied to a temporary file and migrated there; the original is never written.
export const openReadable = async (databasePath) => {
  const source = openDatabase(databasePath, { readOnly: true });
  if (isCurrent(source)) return { db: source, source, close: () => source.close() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), SNAPSHOT_PREFIX));
  const file = path.join(dir, SNAPSHOT_FILE);
  await backup(source, file);
  const db = openDatabase(file);
  const close = () => {
    db.close();
    source.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, source, close };
};
