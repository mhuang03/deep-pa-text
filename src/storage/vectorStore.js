import { createVectorGuard } from './vectorGuard.js';
import { createCollectionLoader } from './vectorCollections.js';
import { createVectorConnection } from './vectorConnect.js';
import { createVectorReads } from './vectorReads.js';
import { createVectorWrites } from './vectorWrites.js';

export { collectionNames } from './vectorCollections.js';

export const createVectorStore = ({ client, embeddingFunction, config, generation = null, clock }) => {
  if (!clock) throw new Error('createVectorStore requires a clock');
  const guard = createVectorGuard({ config, clock });
  const { collections } = createCollectionLoader({ client, embeddingFunction, config, generation, guard });
  return {
    ...createVectorConnection({ client, config, guard, collections }),
    ...createVectorReads({ guard, collections, embeddingFunction }),
    ...createVectorWrites({ guard, collections }),
  };
};
