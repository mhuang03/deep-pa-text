const URL_PATTERN = /^https?:\/\//;

const isUrl = (value) => typeof value === 'string' && URL_PATTERN.test(value);

// Defensive: an unexpected body shape yields no URLs rather than throwing.
const collectUrls = (items, pick, limit) => {
  if (!Array.isArray(items)) return [];
  const urls = items.map(pick).filter(isUrl);
  return [...new Set(urls)].slice(0, limit);
};

const getJson = async (fetch, url, name) => {
  const response = await fetch(url);
  if (response.ok === false) throw new Error(`${name} responded ${response.status}`);
  return response.json();
};

const klipyUrl = (item) => item?.file?.hd?.gif?.url;
const giphyUrl = (item) => item?.images?.original?.url;
const humorUrl = (item) => item?.url;

export const createKlipyEngine = ({ fetch, config }) => ({
  name: 'klipy',
  search: async (query) => {
    const g = config.gifs;
    const params = new URLSearchParams({
      page: 1,
      per_page: g.klipyPerPage,
      q: query,
      customer_id: g.klipyCustomerId,
      locale: g.klipyLocale,
      content_filter: g.klipyContentFilter,
      format_filter: g.klipyFormatFilter,
    });
    const url = `${g.klipyBaseUrl}/${g.klipyApiKey}/gifs/search?${params.toString()}`;
    const data = await getJson(fetch, url, 'klipy');
    return collectUrls(data?.data?.data, klipyUrl, g.candidates);
  },
});

export const createGiphyEngine = ({ giphy, config }) => ({
  name: 'giphy',
  search: async (query) => {
    const limit = config.gifs.candidates;
    const result = await giphy.search(query, { limit });
    return collectUrls(result?.data, giphyUrl, limit);
  },
});

export const createHumorEngine = ({ fetch, config }) => ({
  name: 'humor',
  search: async (query) => {
    const g = config.gifs;
    const params = new URLSearchParams({
      'api-key': g.humorApiKey,
      number: g.candidates,
      query,
    });
    const data = await getJson(fetch, `${g.humorUrl}?${params.toString()}`, 'humor');
    return collectUrls(data?.images, humorUrl, g.candidates);
  },
});
