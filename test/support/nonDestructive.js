import { scanJs } from './jsScan.js';

const SQL_FIRST_TOKENS = new Set([
  'SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'REPLACE', 'CREATE', 'ALTER', 'VACUUM', 'PRAGMA',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'ATTACH', 'DETACH', 'REINDEX', 'TRUNCATE',
]);
const SECOND_KEYWORD =
  /\b(FROM|INTO|SET|TABLE|INDEX|VIEW|WHERE|VALUES|COLUMN|TRIGGER|SELECT|DATABASE|RENAME|IF\s+NOT\s+EXISTS)\b|\w+_\w+|\w+\s*=\s*\?|\w+\.\w+/i;
const BARE_STATEMENT = /^(VACUUM|REINDEX|BEGIN(\s+(IMMEDIATE|DEFERRED|EXCLUSIVE))?|COMMIT|ROLLBACK)\s*;?$/i;
const TRANSACTION_STATEMENT = /^(BEGIN(\s+(IMMEDIATE|DEFERRED|EXCLUSIVE))?|COMMIT|ROLLBACK)\s*;?$/i;
const DESTRUCTIVE_PREFIX = /^(DROP|TRUNCATE|REINDEX|ATTACH|DETACH|VACUUM)\s+\w/i;
const PRAGMA_STATEMENT = /^PRAGMA\s+\w+/i;
const DML_KEYWORD = /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|VACUUM)\b/i;
const SOFT_DELETE_UPDATE =
  /^UPDATE\s+\w+\s+SET\s+deleted_at\s*=\s*\?\s+WHERE\b[\s\S]*\bdeleted_at\s+IS\s+NULL\b/i;
const INSERT_FORBIDDEN = /\b(DO\s+UPDATE|OR\s+REPLACE|OR\s+IGNORE)\b/i;
const ALLOWED_STATEMENT = [
  /^SELECT\b/i,
  /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i,
  /^CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\b/i,
  /^ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\b/i,
  PRAGMA_STATEMENT,
  TRANSACTION_STATEMENT,
];
const COLUMN_FORBIDDEN = [/\bPRIMARY\s+KEY\b/i, /\bUNIQUE\b/i, /\bREFERENCES\b/i];
const NOT_NULL = /\bNOT\s+NULL\b/i;
const DEFAULT = /\bDEFAULT\b/i;

const FILE_FUNCTIONS = [
  'rm', 'rmdir', 'unlink', 'truncate', 'ftruncate', 'writeFile', 'appendFile', 'cp', 'copyFile', 'rename', 'link',
];
const FILE_CALL = new RegExp(`(?<![\\w$])(${FILE_FUNCTIONS.map((n) => `${n}(?:Sync)?`).join('|')})\\s*\\(`, 'g');
const MOVE_EXCEPTIONS = new Set(['renameSync', 'linkSync', 'copyFileSync']);
export const DATABASE_SWITCH = 'src/backfill/databaseSwitch.js';
const VECTOR_FILE = /^src\/storage\/vector\w*\.js$/;
const COLLECTION =
  '(?:\\b\\w*ollection|(?:get|getOrCreate|create)Collection\\([^)]*\\)\\)?|collections\\([^)]*\\)\\)?)';
const COLLECTION_CALL = (methods) => new RegExp(`${COLLECTION}\\s*\\??\\.\\s*(?:${methods})\\s*\\(`, 'g');
const ALWAYS_FORBIDDEN_CHROMA = /(?<![\w$])deleteCollection\s*\(|\.\s*reset\s*\(|\.\s*modify\s*\(/g;

const normalise = (sql) => sql.replace(/\s+/g, ' ').trim();
const firstToken = (sql) => sql.split(/[\s(;]/)[0].toUpperCase();

// A string is SQL when it opens with an SQL verb and has a second SQL token, or is a bare statement.
export const isSqlString = (value) => {
  const sql = normalise(value);
  if (!SQL_FIRST_TOKENS.has(firstToken(sql))) return false;
  return BARE_STATEMENT.test(sql) || DESTRUCTIVE_PREFIX.test(sql) || SECOND_KEYWORD.test(sql.slice(firstToken(sql).length));
};

const isAllowedInsert = (sql) => /^INSERT\s+INTO\b/i.test(sql) && !INSERT_FORBIDDEN.test(sql);
const isAllowedWith = (sql) => /^WITH\b/i.test(sql) && /\bSELECT\b/i.test(sql) && !DML_KEYWORD.test(sql);
const isAllowedUpdate = (sql) => SOFT_DELETE_UPDATE.test(sql);

export const isAllowedSql = (value) => {
  const sql = normalise(value);
  return ALLOWED_STATEMENT.some((pattern) => pattern.test(sql))
    || isAllowedInsert(sql) || isAllowedWith(sql) || isAllowedUpdate(sql);
};

export const sqlViolations = (text) =>
  scanJs(text).strings.filter((value) => isSqlString(value) && !isAllowedSql(value)).map(normalise);

export const addColumnViolations = (definition) => {
  const problems = COLUMN_FORBIDDEN.filter((pattern) => pattern.test(definition)).map((p) => p.source);
  if (NOT_NULL.test(definition) && !DEFAULT.test(definition)) problems.push('NOT NULL without DEFAULT');
  return problems;
};

const matches = (pattern, code) => [...code.matchAll(pattern)].map((match) => match[0].replace(/\s+/g, ''));

export const chromaViolations = (text, file = '') => {
  const { code } = scanJs(text);
  const found = matches(ALWAYS_FORBIDDEN_CHROMA, code);
  found.push(...matches(COLLECTION_CALL('delete|update'), code));
  if (!VECTOR_FILE.test(file)) found.push(...matches(COLLECTION_CALL('upsert|add'), code));
  return found;
};

export const fileViolations = (text, file = '') => {
  const { code } = scanJs(text);
  return [...code.matchAll(FILE_CALL)].map((match) => match[1])
    .filter((name) => !(file === DATABASE_SWITCH && MOVE_EXCEPTIONS.has(name)));
};
