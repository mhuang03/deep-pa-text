// The model sometimes wraps its JSON in prose; take the outermost braces and parse them.
export const parseJsonObject = (text) => {
  const source = String(text);
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let value;
  try {
    value = JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
  const isPlain = value !== null && typeof value === 'object' && !Array.isArray(value);
  return isPlain ? value : null;
};
