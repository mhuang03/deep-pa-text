import { formatTimestamp } from '../logger.js';

const stamp = (ms, logging) => formatTimestamp(ms, logging);

export const formatReceived = ({ record, kept, logging }) =>
  `[${stamp(record.timestamp, logging)}] ${record.author}: ${record.content}`
  + `\n  [filter kept: ${kept ? 'yes' : 'no'}] (reference: ${record.reference})`;

export const formatNoReply = (decision) => {
  if (decision.reason === 'rate-limited') return '    [NOREPLY: rate limited]';
  if (decision.reason === 'in-flight') return '    [NOREPLY: another reply is in flight]';
  if (decision.reason === 'cooldown') return '    [NOREPLY: cooling down after a failed reply]';
  return `    [NOREPLY: random ${decision.roll.toFixed(2)} > ${decision.chance}]`;
};

export const formatNotReplyable = () => '    [NOREPLY: not replyable]';

export const formatReply = ({ persona, response }) => `    [REPLY] ${persona}: ${response}`;

export const formatRevive = ({ persona, response }) => `[REVIVE] ${persona}: ${response}`;

export const formatCommandRequest = ({ requester, record, logging }) =>
  `[REQUEST REPLY from ${requester}] [${stamp(record.timestamp, logging)}] ${record.author}: ${record.content}`;

export const joinLines = (lines) => lines.join('\n');

export const formatChainDecision = ({ persona, botTurns, decision }) =>
  `    [CHAIN: ${persona}, ${botTurns} bot turns, ${decision.reason}${decision.reply ? '' : ', no reply'}]`;
