// Finds function boundaries with brace matching over masked source: function declarations and
// expressions, arrow functions (block or expression body) and object-method shorthand.
import { maskJs } from './maskJs.js';

const OPENERS = { ')': '(', ']': '[', '}': '{' };
const CLOSERS = new Set([')', ']', '}']);
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'await']);

const matchForward = (code, open) => {
  const pair = { '(': ')', '[': ']', '{': '}' }[code[open]];
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === code[open]) depth += 1;
    else if (code[i] === pair) depth -= 1;
    if (depth === 0) return i;
  }
  return code.length - 1;
};

const matchBackward = (code, close) => {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (code[i] === code[close]) depth += 1;
    else if (code[i] === OPENERS[code[close]]) depth -= 1;
    if (depth === 0) return i;
  }
  return 0;
};

const countParams = (code, open, close) => {
  const inner = code.slice(open + 1, close);
  if (inner.trim() === '') return 0;
  let depth = 0;
  let count = 1;
  for (const ch of inner) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) count += 1;
  }
  return inner.trim().endsWith(',') ? count - 1 : count;
};

const skipSpace = (code, from) => {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  return i;
};

const expressionEnd = (code, from) => {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    const ch = code[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (CLOSERS.has(ch)) {
      if (depth === 0) return i - 1;
      depth -= 1;
    } else if ((ch === ',' || ch === ';') && depth === 0) return i - 1;
  }
  return code.length - 1;
};

const lineOf = (starts, offset) => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
};

const arrowParams = (code, arrow) => {
  let end = arrow - 1;
  while (/\s/.test(code[end])) end -= 1;
  if (code[end] === ')') return { open: matchBackward(code, end), close: end };
  let start = end;
  while (/\w/.test(code[start - 1] ?? '')) start -= 1;
  return { open: start - 1, close: end + 1, bare: true, start };
};

const arrowFunctions = (code) => [...code.matchAll(/=>/g)].map((m) => {
  const params = arrowParams(code, m.index);
  const bodyStart = skipSpace(code, m.index + 2);
  const end = code[bodyStart] === '{' ? matchForward(code, bodyStart) : expressionEnd(code, bodyStart);
  const start = params.bare ? params.start : params.open;
  return { start, end, params: params.bare ? 1 : countParams(code, params.open, params.close), kind: 'arrow' };
});

const declared = (code) => [...code.matchAll(/function\s*\*?\s*[\w$]*\s*\(/g)].map((m) => {
  const open = m.index + m[0].length - 1;
  const close = matchForward(code, open);
  const brace = skipSpace(code, close + 1);
  return { start: m.index, end: matchForward(code, brace), params: countParams(code, open, close), kind: 'function' };
});

const methods = (code) => [...code.matchAll(/(?<![\w$.])(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/g)]
  .filter((m) => !NOT_METHODS.has(m[1]))
  .flatMap((m) => {
    const open = m.index + m[0].length - 1;
    const close = matchForward(code, open);
    const brace = skipSpace(code, close + 1);
    if (code[brace] !== '{' || /function\s*$/.test(code.slice(0, m.index))) return [];
    return [{ start: m.index, end: matchForward(code, brace), params: countParams(code, open, close), kind: 'method' }];
  });

export const findFunctions = (text) => {
  const code = maskJs(text);
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return [...arrowFunctions(code), ...declared(code), ...methods(code)]
    .map((fn) => ({
      kind: fn.kind,
      params: fn.params,
      startLine: lineOf(starts, fn.start),
      endLine: lineOf(starts, fn.end),
    }))
    .map((fn) => ({ ...fn, lines: fn.endLine - fn.startLine + 1 }));
};
