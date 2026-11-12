// Reads both received embeds (embed.author) and builders (embed.data.author).
const authorName = (embed) => embed?.author?.name ?? embed?.data?.author?.name ?? null;

export const readPersonaFromEmbeds = (discordMessage, userDirectory) => {
  const names = (discordMessage?.embeds ?? []).map(authorName).filter(Boolean);
  const last = names.at(-1);
  return last && userDirectory.usernames.has(last) ? last : null;
};
