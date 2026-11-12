import { createCompleter } from './generatorComplete.js';
import { createGeneratorInputs } from './generatorInputs.js';
import { createReplyGenerator } from './replyGenerator.js';
import { createReviveGenerator } from './reviveGenerator.js';

export const createGenerator = ({
  chatClient, retriever, userDirectory, botMessageStore, messageStore, burstProfile, config, logger,
}) => {
  const { complete } = createCompleter({ chatClient, config, logger });
  const inputs = createGeneratorInputs({ botMessageStore, messageStore, burstProfile, config, logger });
  const shared = { complete, retriever, userDirectory, inputs, config };
  return { ...createReplyGenerator(shared), ...createReviveGenerator(shared) };
};
