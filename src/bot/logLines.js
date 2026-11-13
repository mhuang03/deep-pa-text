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

export const formatConversation = ({ topic, personas, delivered, planned }) =>
  `[CONVERSATION] ${topic} (${personas.join(', ')}): ${delivered} of ${planned} turns delivered`;

export const formatCommandRequest = ({ requester, record, logging }) =>
  `[REQUEST REPLY from ${requester}] [${stamp(record.timestamp, logging)}] ${record.author}: ${record.content}`;

export const joinLines = (lines) => lines.join('\n');

export const formatChainDecision = ({ persona, botTurns, decision }) =>
  `    [CHAIN: ${persona}, ${botTurns} bot turns, ${decision.reason}${decision.reply ? '' : ', no reply'}]`;

const TRIGGER_LABELS = {
  auto: 'auto reply', chain: 'chain reply', command: 'command reply', revive: 'revive', conversation: 'conversation turn',
};

// The label of a handler-level error log: which work failed, for whom and where.
export const formatFailure = ({ what, messageId, trigger, persona, stage }) => {
  const label = trigger ? (TRIGGER_LABELS[trigger] ?? trigger) : null;
  const details = [
    label && persona ? `${label} as ${persona}` : label ?? (persona ? `as ${persona}` : null),
    stage ? `stage ${stage}` : null,
  ].filter(Boolean);
  const subject = messageId ? `${what} ${messageId}` : what;
  return `${subject}${details.length > 0 ? ` (${details.join(', ')})` : ''}:`;
};
