const isUsable = (vector) => Array.isArray(vector) && vector.length > 0;

export const cosineSimilarity = (a, b) => {
  if (!isUsable(a) || !isUsable(b) || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  a.forEach((x, i) => {
    dot += x * b[i];
    normA += x * x;
    normB += b[i] * b[i];
  });
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};
