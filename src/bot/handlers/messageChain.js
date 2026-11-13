// The thread-continuation path of the message handler.
import { TRIGGERS } from '../../util/triggers.js';
import { formatReply, formatChain, joinLines } from '../logLines.js';
import { respondTo } from './messageAutoReply.js';

// With chains off, a reply to a bot message is an ordinary message.
export const buildChain = ({ config, messageFilter, chainBuilder }, record, parent) => {
  if (!config.chain.enabled) return null;
  const target = parent && messageFilter.filterForChain(record);
  const chain = target && chainBuilder.build(target, parent);
  return chain ? { chain, target } : null;
};

// A reply in a thread with a bot message continues it as the same persona. The person asked for it,
// so it is always answered: no roll, no cap, no cooldown.
export const chainReply = async (deps, { message, threaded, lines }) => {
  const { replyPolicy, logger } = deps;
  const { chain, target } = threaded;
  const { persona, botTurns } = chain;
  const onDelivered = () => replyPolicy.noteReply({ resetMisses: false });
  const request = { trigger: TRIGGERS.CHAIN, persona, target, chain, onDelivered };
  const { response } = await respondTo(deps, { message, request });
  return logger.info(joinLines([...lines, formatChain({ persona, botTurns }), formatReply({ persona, response })]));
};
