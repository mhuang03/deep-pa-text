// The thread-continuation path of the message handler.
import { TRIGGERS } from '../../util/triggers.js';
import { formatReply, formatChain, joinLines } from '../logLines.js';
import { respondTo } from './messageAutoReply.js';
import { isMention, readRequest } from './messageMention.js';

// What the message says and whom it asks for: a ping may start with a persona's name.
const readIncoming = (deps, { message, record }) =>
  (isMention(deps, message) ? readRequest(deps, record) : { text: record.content, persona: null });

// Only a name was written: the named persona answers the bot message itself, inside its thread.
const answerParent = ({ chainBuilder }, { record, parent, persona }) => {
  if (!persona || persona === parent.persona) return null;
  const chain = chainBuilder.build(null, parent, { persona });
  const target = {
    id: parent.id, author: parent.persona, content: parent.content, timestamp: parent.timestamp ?? record.timestamp,
  };
  return chain ? { chain, target } : null;
};

// With chains off, a reply to a bot message is an ordinary message. A pinged name other than the
// thread's persona joins the thread: the same turns, seen from that persona's side.
export const buildChain = (deps, { message, record, parent }) => {
  const { config, messageFilter, chainBuilder } = deps;
  if (!config.chain.enabled || !parent) return null;
  const { text, persona } = readIncoming(deps, { message, record });
  const target = messageFilter.filterForChain({ ...record, content: text });
  if (!target) return answerParent(deps, { record, parent, persona });
  const chain = chainBuilder.build(target, parent, { persona: persona ?? parent.persona });
  return chain ? { chain, target } : null;
};

// A reply in a thread with a bot message continues it, as its persona or the one named. The person asked for it,
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
