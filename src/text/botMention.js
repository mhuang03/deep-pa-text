// A ping written in the message text. The automatic mention Discord adds to a reply is not in the
// content, so it never counts.
const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const pattern = (userId) => new RegExp(`<@!?${escapeForRegExp(userId)}>`, 'g');

const isUserId = (userId) => typeof userId === 'string' && userId !== '';

export const mentionsUser = (content, userId) =>
  Boolean(content) && isUserId(userId) && pattern(userId).test(content);

export const stripUserMention = (content, userId) => {
  if (!content || !isUserId(userId)) return content ?? '';
  return content.replace(pattern(userId), ' ').replace(/\s+/g, ' ').trim();
};
