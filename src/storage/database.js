import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

const hasColumn = (db, table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);

const applyAddColumn = (db, { table, column, definition }) => {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};

const applyMigration = (db, migration) => {
  if (migration.sql) {
    db.exec(migration.sql);
    return;
  }
  applyAddColumn(db, migration.addColumn);
};

export const runMigrations = (db, migrations = MIGRATIONS) => {
  migrations.forEach((migration) => applyMigration(db, migration));
};

export const openDatabase = (path, { readOnly = false } = {}) => {
  const db = new DatabaseSync(path, { readOnly });
  if (!readOnly) runMigrations(db);
  return db;
};
