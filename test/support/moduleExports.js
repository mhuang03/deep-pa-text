// Finds the named exports of each module and which of them some other file imports.
import fs from 'node:fs';
import path from 'node:path';
import { maskJs } from './maskJs.js';
import { resolveSpecifier } from './importGraph.js';

const DECLARATION = /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}\s*(?:from\s*(['"])([^'"]+)\2)?/g;
const IMPORT_LIST = /\bimport\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;
const NAMESPACE = /\bimport\s*\*\s*as\s+[\w$]+\s+from\s*(['"])([^'"]+)\1/g;
const EXPORT_STAR = /\bexport\s*\*\s*from\s*(['"])([^'"]+)\1/g;

const names = (list, pick) => list.split(',').map((item) => item.trim()).filter(Boolean)
  .map((item) => pick(item.split(/\s+as\s+/)));
const original = (parts) => parts[0];
const exposed = (parts) => parts.at(-1);

export const exportsOf = (text) => {
  const code = maskJs(text);
  const declared = [...code.matchAll(DECLARATION)].map((m) => m[1]);
  const listed = [...code.matchAll(EXPORT_LIST)].flatMap((m) => names(m[1], exposed));
  return [...declared, ...listed];
};

// Returns Map(resolved target -> Set of imported names, or '*' for a namespace or star import).
export const importedNames = (file, text) => {
  const code = maskJs(text, { keepStrings: true });
  const used = new Map();
  const add = (specifier, list) => {
    const target = resolveSpecifier(file, specifier);
    if (!target) return;
    if (!used.has(target)) used.set(target, new Set());
    list.forEach((name) => used.get(target).add(name));
  };
  [...code.matchAll(IMPORT_LIST)].forEach((m) => add(m[3], names(m[1], original)));
  [...code.matchAll(EXPORT_LIST)].filter((m) => m[3]).forEach((m) => add(m[3], names(m[1], original)));
  [...code.matchAll(NAMESPACE)].forEach((m) => add(m[2], ['*']));
  [...code.matchAll(EXPORT_STAR)].forEach((m) => add(m[2], ['*']));
  return used;
};

export const collectUsage = (files) => {
  const usage = new Map();
  files.forEach((file) => {
    importedNames(file, fs.readFileSync(file, 'utf8')).forEach((set, target) => {
      if (!usage.has(target)) usage.set(target, new Set());
      set.forEach((name) => usage.get(target).add(name));
    });
  });
  return usage;
};

export const unusedExports = (srcFiles, usage) => srcFiles.flatMap((file) => {
  const used = usage.get(file) ?? new Set();
  if (used.has('*')) return [];
  return exportsOf(fs.readFileSync(file, 'utf8'))
    .filter((name) => !used.has(name))
    .map((name) => `${path.basename(file)}: ${name}`);
});
