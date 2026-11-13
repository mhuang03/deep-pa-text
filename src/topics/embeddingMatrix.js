import { normaliseRow } from '../util/vectorMath.js';

const pagesOf = (rows, size) => {
  const pages = [];
  for (let i = 0; i < rows.length; i += size) pages.push(rows.slice(i, i + size));
  return pages;
};

// Copies one page of stored embeddings into the matrix, unit length. A row with no embedding, a different
// dimension or zero length is dropped.
const addPage = (state, page, found) => {
  page.forEach((row) => {
    const embedding = found.get(row.id);
    if (!embedding) return;
    state.dimensions ??= embedding.length;
    if (embedding.length !== state.dimensions) return;
    state.buffer ??= new Float32Array(state.capacity * state.dimensions);
    const offset = state.rows.length * state.dimensions;
    state.buffer.set(embedding, offset);
    if (!normaliseRow(state.buffer, offset, state.dimensions)) return;
    state.rows.push(row);
  });
};

// Reads the stored embeddings (nothing is embedded again) into one flat Float32Array, page by page.
export const buildMatrix = async ({ rows, vectorStore, pageSize }) => {
  const state = { rows: [], buffer: null, dimensions: null, capacity: rows.length };
  for (const page of pagesOf(rows, pageSize)) {
    const found = await vectorStore.getEmbeddings(page.map((row) => row.id), { batch: true });
    addPage(state, page, found);
  }
  const dimensions = state.dimensions ?? 0;
  const vectors = state.buffer ? state.buffer.slice(0, state.rows.length * dimensions) : new Float32Array(0);
  return { rows: state.rows, vectors, dimensions, dropped: rows.length - state.rows.length };
};
