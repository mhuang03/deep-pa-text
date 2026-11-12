const MIN_SECRET_LENGTH = 8;

// Short values would redact ordinary words, so they are not treated as secrets. Longest first so a
// secret that contains another is replaced whole.
export const secretsOf = (config) => {
  const { discord, llm, embedding, gifs } = config;
  const values = [discord.token, llm.apiKey, embedding.apiKey, gifs.klipyApiKey, gifs.giphyApiKey, gifs.humorApiKey];
  const usable = values.filter((value) => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH);
  return [...new Set(usable)].sort((a, b) => b.length - a.length);
};
