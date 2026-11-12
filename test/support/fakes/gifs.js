const createEngine = () => {
  let result = null;
  const engine = {
    calls: [],
    setResult: (x) => {
      result = x;
    },
    lookup: (query) => {
      const value = typeof result === 'function' ? result(query) : result;
      if (value instanceof Error) throw value;
      return value ?? null;
    },
  };
  return engine;
};

const klipyBody = (url) => ({ data: { data: url ? [{ file: { hd: { gif: { url } } } }] : [] } });
const humorBody = (url) => ({ images: url ? [{ url }] : [] });
const jsonResponse = (body) => ({ json: async () => body });

export const createFakeGifs = () => {
  const state = { klipy: createEngine(), giphy: createEngine(), humor: createEngine(), constructed: [] };

  class GiphyFetch {
    constructor(...args) {
      state.constructed.push(args);
    }

    async search(term, options) {
      state.giphy.calls.push([term, options]);
      const url = state.giphy.lookup(term);
      return { data: url ? [{ images: { original: { url } } }] : [] };
    }
  }

  const routes = {
    'api.klipy.com': (url) => {
      state.klipy.calls.push(url);
      return jsonResponse(klipyBody(state.klipy.lookup(url.searchParams.get('q'))));
    },
    'api.humorapi.com': (url) => {
      state.humor.calls.push(url);
      return jsonResponse(humorBody(state.humor.lookup(url.searchParams.get('query'))));
    },
  };

  const fetch = async (input) => {
    const url = new URL(String(input));
    const route = routes[url.hostname];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return route(url);
  };

  return { GiphyFetch, fetch, state };
};
