import { prepareStatements } from './messageStatements.js';
import { createMessageEdits } from './messageEdits.js';
import { createMessageQueries } from './messageQueries.js';
import { createMessageTopicQueries } from './messageTopicQueries.js';

export const createMessageStore = ({ db, config }) => {
  const statements = prepareStatements(db);
  return {
    ...createMessageEdits({ db, statements, windowMs: config.storage.inferredReferenceWindowMs }),
    ...createMessageQueries({ db, statements, chunkSize: config.storage.chunkSize }),
    ...createMessageTopicQueries({ db }),
  };
};
