// Returns the source with comments, string literals, regex literals and template text replaced by spaces
// (newlines kept, so offsets and line numbers are unchanged). Template `${...}` expressions stay as code.
const REGEX_PREFIX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = /(?:return|typeof|case|throw|yield|await|of|in)$/;

const blank = (ch) => (ch === '\n' ? '\n' : ' ');

export const maskJs = (text, { keepStrings = false } = {}) => {
  const out = text.split('');
  const templates = [];
  let i = 0;
  let prev = '';
  let prevWord = '';

  const mask = (from, to) => {
    for (let k = from; k < to; k += 1) out[k] = blank(text[k]);
  };
  const skipQuoted = (quote) => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
    i += 1;
    if (!keepStrings) mask(start + 1, i - 1);
  };
  const skipRegex = () => {
    const start = i;
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
    mask(start + 1, i - 1);
  };
  const templateText = () => {
    const start = i;
    while (i < text.length && text[i] !== '`' && !(text[i] === '$' && text[i + 1] === '{')) i += text[i] === '\\' ? 2 : 1;
    mask(start, i);
    if (text[i] === '`') {
      i += 1;
      return;
    }
    if (i < text.length) {
      i += 2;
      templates.push(0);
    }
  };
  const isRegexStart = () => prev === '' || REGEX_PREFIX.has(prev) || REGEX_KEYWORDS.test(prevWord);

  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      mask(i, stop);
      i = stop;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      mask(i, stop);
      i = stop;
    } else if (ch === '\'' || ch === '"') {
      skipQuoted(ch);
      prev = 'x';
      prevWord = '';
    } else if (ch === '`') {
      i += 1;
      templateText();
      prev = 'x';
      prevWord = '';
    } else if (ch === '/' && isRegexStart()) {
      skipRegex();
      while (/[a-z]/i.test(text[i] ?? '')) i += 1;
      prev = 'x';
      prevWord = '';
    } else if (templates.length > 0 && ch === '{') {
      templates[templates.length - 1] += 1;
      i += 1;
      prev = '{';
    } else if (templates.length > 0 && ch === '}') {
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        i += 1;
        templateText();
        prev = 'x';
      } else {
        templates[templates.length - 1] -= 1;
        i += 1;
        prev = '}';
      }
    } else {
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (/\w/.test(ch)) prevWord = /\w/.test(text[i - 1] ?? '') ? prevWord + ch : ch;
      else prevWord = '';
      prev = ch;
      i += 1;
    }
  }
  return out.join('');
};
