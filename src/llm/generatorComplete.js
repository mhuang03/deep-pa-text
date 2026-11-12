import { postProcess } from './postProcess.js';
import { SYSTEM_PROMPT } from './prompts.js';

// Output that sanitises to nothing is worth another completion; a failed chat client is not retried here.
export const createCompleter = ({ chatClient, config, logger }) => ({
  complete: async (user, system = SYSTEM_PROMPT, turns = null) => {
    const request = turns ? { system, user, turns } : { system, user };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return postProcess(await chatClient.complete(request), {
          burst: config.burst, maxGifsPerMessage: config.gifs.maxPerMessage,
        });
      } catch (error) {
        if (!error.isEmptyOutput || attempt >= config.llm.postProcessRetries) throw error;
        logger?.warn?.('Model output was empty after cleaning; requesting a new completion');
      }
    }
  },
});
