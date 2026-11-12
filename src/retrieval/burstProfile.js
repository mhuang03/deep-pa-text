// How often an author follows a message with another one straight away, as a rate in [0, 1].
export const createBurstProfile = ({ messageStore, config, now }) => {
  const { windowMs, minSamples, cacheMs } = config.burst;
  const cache = new Map();

  const measure = (author) => {
    const { samples, rate } = messageStore.burstStats({ author, windowMs });
    return samples < minSamples ? 0 : rate;
  };

  const rateFor = (author) => {
    const cached = cache.get(author);
    if (cached && now() - cached.at < cacheMs) return cached.rate;
    const rate = measure(author);
    cache.set(author, { at: now(), rate });
    return rate;
  };

  return { rateFor };
};
