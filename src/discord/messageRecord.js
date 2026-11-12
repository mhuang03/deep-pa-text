export const toMessageRecord = (message) => ({
  id: message.id,
  author: message.author.username,
  content: message.content,
  timestamp: message.createdTimestamp,
  reference: message.reference?.messageId || null,
});
