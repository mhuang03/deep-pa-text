import { DEFAULTS } from '../config.js';

const getJson = async (fetch, url) => (await fetch(url)).json();

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
    const data = await getJson(fetch, url);
    return data.data?.data[0]?.file.hd.gif.url || '';
  },
});

export const createGiphyEngine = ({ giphy, config }) => {
  const limit = config?.gifs.giphyLimit ?? DEFAULTS.gifs.giphyLimit;
  return {
    name: 'giphy',
    search: async (query) => {
      const { data: gifs } = await giphy.search(query, { limit });
      return gifs[0]?.images?.original?.url || '';
    },
  };
};

export const createHumorEngine = ({ fetch, config }) => ({
  name: 'humor',
  search: async (query) => {
    const g = config.gifs;
    const params = new URLSearchParams({
      'api-key': g.humorApiKey,
      number: g.humorNumber,
      query,
    });
    const data = await getJson(fetch, `${g.humorUrl}?${params.toString()}`);
    return data.images[0]?.url || '';
  },
});
