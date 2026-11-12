import { createConfigError } from '../config/errors.js';

const readStoredDimension = async ({ timed, limits }, messages) => {
  const found = await timed('peek', limits.connect, () => messages.get({ limit: 1, include: ['embeddings'] }));
  return found.embeddings?.[0]?.length ?? null;
};

// A model change with the same dimension cannot be seen without an embedding request.
const assertDimensions = (config, stored) => {
  const expected = config.embedding.dimensions;
  if (stored === null || stored === expected) return;
  throw createConfigError(
    `The Chroma collection holds ${stored}-dimension embeddings but embedding.dimensions is ${expected}. `
    + 'Restore the original embedding settings, or start a new collection with a re-import.',
  );
};

export const createVectorConnection = ({ client, config, guard, collections }) => ({
  connect: async () => {
    await guard.timed('connect', guard.limits.connect, () => client.heartbeat());
    const { messages } = await collections(guard.limits.connect);
    assertDimensions(config, await readStoredDimension(guard, messages));
  },
});
