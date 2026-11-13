// The thread-continuation path of the message handler.
import { TRIGGERS } from '../../util/triggers.js';
import { formatReply, formatChainDecision, joinLines } from '../logLines.js';
import { respondTo } from './messageAutoReply.js';

// With chains off, a reply to a bot message is an ordinary message.
export const buildChain = ({ config, messageFilter, chainBuilder }, record, parent) => {
  if (!config.chain.enabled) return null;
  const target = parent && messageFilter.filterForChain(record);
  const chain = target && chainBuilder.build(target, parent);
  return chain ? { chain, target } : null;
};

// Replies in a thread with a bot message continue it as the same persona; they never reach the random policy.
export const chainReply = async (deps, { message, threaded, lines }) => {
  const { chainPolicy, replyPolicy, logger } = deps;
  const { chain, target } = threaded;
  const { persona, botTurns } = chain;
  const userId = message.author.id;
  const decision = chainPolicy.decide({ ...chain, userId });
  const summary = formatChainDecision({ persona, botTurns, decision });
  if (!decision.reply) return logger.info(joinLines([...lines, summary]));
  chainPolicy.begin({ userId });
  try {
    const onDelivered = () => replyPolicy.noteReply({ resetMisses: false });
    const request = { trigger: TRIGGERS.CHAIN, persona, target, chain, onDelivered };
    const { response } = await respondTo(deps, { message, request });
    return logger.info(joinLines([...lines, summary, formatReply({ persona, response })]));
  } finally {
    chainPolicy.end();
  }
};
