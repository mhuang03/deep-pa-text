// The mention path of the message handler: a ping written in a message summons a reply.
import { TRIGGERS } from '../../util/triggers.js';
import { mentionsUser, stripUserMention } from '../../text/botMention.js';
import { matchPersonaPrefix } from '../../text/personaPrefix.js';
import { toMessageRecord } from '../../discord/messageRecord.js';
import { formatReply, formatMentionWithoutTarget, joinLines } from '../logLines.js';
import { respondTo } from './messageAutoReply.js';

const botId = ({ client }) => client.user?.id;

export const isMention = (deps, message) =>
  deps.config.mention.enabled && mentionsUser(message.content, botId(deps));

// A referenced message the bot never stored is read from Discord; a failed fetch counts as none.
const fetchReferenced = async ({ logger }, message) => {
  try {
    return toMessageRecord(await message.fetchReference());
  } catch (error) {
    logger.warn(`Could not fetch the message a mention points at (${message.id}):`, error);
    return null;
  }
};

// A ping with no text of its own points at the message it replies to, else at the one before it.
const pointedAt = async (deps, { message, record }) => {
  const { messageStore } = deps;
  if (!record.reference) return messageStore.previousRaw({ before: record.timestamp, excludeId: record.id });
  return messageStore.getRaw(record.reference) ?? fetchReferenced(deps, message);
};

// "bob what do you think" asks for bob by name; the name is not part of what is answered.
export const readRequest = ({ config, users, client }, record) => {
  const text = stripUserMention(record.content, client.user?.id);
  const named = config.mention.namedPersona ? matchPersonaPrefix(text, users, config.mention) : null;
  return { text: named ? named.rest : text, persona: named?.persona ?? null };
};

const findTarget = async (deps, { message, record, text }) => {
  const { messageFilter } = deps;
  const own = messageFilter.filterForChain({ ...record, content: text });
  if (own) return own;
  const other = await pointedAt(deps, { message, record });
  return other && !other.deleted ? messageFilter.filterForChain(other) : null;
};

// Asked for by a person, so it is never rolled, rate limited or capped; it only arms the auto-reply limit.
export const mentionReply = async (deps, { message, record, lines }) => {
  const { personaSelector, replyPolicy, logger } = deps;
  const request = readRequest(deps, record);
  const target = await findTarget(deps, { message, record, text: request.text });
  if (!target) return logger.info(joinLines([...lines, formatMentionWithoutTarget()]));
  const persona = request.persona ?? await personaSelector.pickReplier(target);
  const onDelivered = () => replyPolicy.noteReply({ resetMisses: false });
  const reply = { trigger: TRIGGERS.MENTION, persona, target, onDelivered };
  const { response } = await respondTo(deps, { message, request: reply });
  return logger.info(joinLines([...lines, formatReply({ persona, response })]));
};
