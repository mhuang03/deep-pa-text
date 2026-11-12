const toEmbed = (embed) => {
  const name = embed?.author?.name ?? embed?.data?.author?.name ?? null;
  return { author: name ? { name } : null };
};

// A small plain copy: a full import holds every message of the channel in memory.
export const toHistoryMessage = (message) => ({
  id: message.id,
  content: message.content ?? '',
  createdTimestamp: message.createdTimestamp,
  editedTimestamp: message.editedTimestamp ?? null,
  author: { id: message.author.id, username: message.author.username, bot: Boolean(message.author.bot) },
  webhookId: message.webhookId ?? null,
  reference: message.reference?.messageId ? { messageId: message.reference.messageId } : null,
  embeds: (message.embeds ?? []).map(toEmbed),
  url: message.url,
});
