// A small JavaScript scanner for the non-destructive guard: it separates code from string and template
// literals (so SQL can be checked as data and calls as code) and skips comments and regex literals.
const QUOTES = new Set(['\'', '"']);
const REGEX_PREFIX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const INTERPOLATION = 'x';

export const scanJs = (text) => {
  const strings = [];
  let code = '';
  let i = 0;
  const last = () => code.trimEnd().slice(-1);

  const skipRegex = () => {
    let inClass = false;
    i += 1;
    while (i < text.length) {
      const ch = text[i];
      i += 1;
      if (ch === '\\') i += 1;
      else if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
    }
    while (/[a-z]/i.test(text[i] ?? '')) i += 1;
    code += ' 0 ';
  };

  const readQuoted = (quote) => {
    let value = '';
    i += 1;
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\\') i += 1;
      value += text[i];
      i += 1;
    }
    i += 1;
    strings.push(value);
    code += '""';
  };

  const readInterpolation = () => {
    let depth = 1;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1;
      if (text[i] === '}') depth -= 1;
      i += 1;
    }
    code += ` ${text.slice(start, i - 1)} `;
  };

  const readTemplate = () => {
    let value = '';
    i += 1;
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') {
        value += text[i + 1];
        i += 2;
      } else if (text[i] === '$' && text[i + 1] === '{') {
        i += 2;
        value += INTERPOLATION;
        readInterpolation();
      } else {
        value += text[i];
        i += 1;
      }
    }
    i += 1;
    strings.push(value);
    code += '""';
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') i = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i);
    else if (ch === '/' && text[i + 1] === '*') i = text.indexOf('*/', i + 2) === -1 ? text.length : text.indexOf('*/', i + 2) + 2;
    else if (QUOTES.has(ch)) readQuoted(ch);
    else if (ch === '`') readTemplate();
    else if (ch === '/' && (last() === '' || REGEX_PREFIX.has(last()))) skipRegex();
    else {
      code += ch;
      i += 1;
    }
  }
  return { code, strings };
};
