// Builds the static import graph of src/ and scripts/ (import/export ... from, side-effect and dynamic imports).
import fs from 'node:fs';
import path from 'node:path';
import { maskJs } from './maskJs.js';

const STATIC = /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?(['"])([^'"\n]+)\1/g;
const DYNAMIC = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

export const listJs = (dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJs(full);
    return entry.name.endsWith('.js') ? [full] : [];
  })
  : []);

export const specifiersOf = (text) => {
  const code = maskJs(text, { keepStrings: true });
  return [...code.matchAll(STATIC), ...code.matchAll(DYNAMIC)].map((m) => m[2]);
};

export const resolveSpecifier = (fromFile, specifier) => {
  if (!specifier.startsWith('.')) return null;
  return path.resolve(path.dirname(fromFile), specifier);
};

export const buildGraph = (files) => files.map((file) => ({
  file,
  imports: specifiersOf(fs.readFileSync(file, 'utf8')).map((specifier) => ({
    specifier,
    target: resolveSpecifier(file, specifier),
    external: !specifier.startsWith('.'),
  })),
}));
