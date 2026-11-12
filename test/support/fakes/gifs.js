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

const hang = () => new Promise(() => {});
const toUrls = (value) => {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};
const isShaped = (value, key) => value !== null && typeof value === 'object' && !Array.isArray(value) && key in value;

const klipyBody = (urls) => ({ data: { data: urls.map((url) => ({ file: { hd: { gif: { url } } } })) } });
const humorBody = (urls) => ({ images: urls.map((url) => ({ url })) });

const buildResponse = (value, toBody) => {
  if (isShaped(value, 'status')) {
    return { ok: value.status < 400, status: value.status, json: async () => ({}) };
  }
  const body = isShaped(value, 'body') ? value.body : toBody(toUrls(value));
  return { ok: true, status: 200, json: async () => body };
};

const respond = (engine, query, toBody) => {
  const value = engine.lookup(query);
  if (isShaped(value, 'hang')) return hang();
  return buildResponse(value, toBody);
};

export const createFakeGifs = () => {
  const state = { klipy: createEngine(), giphy: createEngine(), humor: createEngine(), constructed: [] };

  class GiphyFetch {
    constructor(...args) {
      state.constructed.push(args);
    }

    async search(term, options) {
      state.giphy.calls.push([term, options]);
      const value = state.giphy.lookup(term);
      if (isShaped(value, 'hang')) return hang();
      const urls = toUrls(value).slice(0, options?.limit ?? Infinity);
      return { data: urls.map((url) => ({ images: { original: { url } } })) };
    }
  }

  const routes = {
    'api.klipy.com': (url) => {
      state.klipy.calls.push(url);
      return respond(state.klipy, url.searchParams.get('q'), klipyBody);
    },
    'api.humorapi.com': (url) => {
      state.humor.calls.push(url);
      return respond(state.humor, url.searchParams.get('query'), humorBody);
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
