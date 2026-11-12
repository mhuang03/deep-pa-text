const sumCounts = (item, counts) =>
  item.variants.reduce((total, variant) => total + (counts.get(variant) ?? 0), 0);

// Counts only spellings seen among the retrieved candidates, so each total is a lower bound.
export const buildFrequent = (items, counts, { frequentMinCount, frequentLimit }) =>
  items
    .map((item, order) => ({ text: item.text, times: sumCounts(item, counts), order }))
    .filter(({ times }) => times >= frequentMinCount)
    .sort((a, b) => b.times - a.times || a.order - b.order)
    .slice(0, frequentLimit)
    .map(({ text, times }) => ({ text, times }));
