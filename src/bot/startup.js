import { createConfigError } from '../config/errors.js';

const STARTED_KEY = 'reimport_started_at';
const COMPLETED_KEY = 'reimport_completed_at';
const CHROMA_PATH = './data/chroma';

export const createStartup = ({ metaStore, vectorStore, bot, config }) => {
  const assertNoUnfinishedReimport = () => {
    if (metaStore.get(STARTED_KEY) === null || metaStore.get(COMPLETED_KEY) !== null) return;
    throw createConfigError(
      'A re-import of this database is unfinished. Finish it with: npm run reimport -- --resume --yes',
    );
  };

  const connectVectorStore = async () => {
    try {
      await vectorStore.connect();
    } catch {
      const { port } = config.chroma;
      throw createConfigError(
        `Cannot reach Chroma on port ${port}. Start it with: npx chroma run --port ${port} --path ${CHROMA_PATH}`,
      );
    }
  };

  const run = async () => {
    assertNoUnfinishedReimport();
    await connectVectorStore();
    await bot.start();
  };

  return { run };
};
