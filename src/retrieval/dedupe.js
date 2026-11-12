// Exact-string dedup within each array and against every earlier array; earlier arrays win.
export const dedupeBuckets = (arrays) => {
  const seen = new Set();
  const keepNew = (item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  };
  return arrays.map((items) => items.filter(keepNew));
};
