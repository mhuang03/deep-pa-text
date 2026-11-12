import { fakeEmbed } from './chroma.js';

const DEFAULT_RESPONSE = 'ok cool';

const resolveResponse = (responder, request) => {
  const value = typeof responder === 'function' ? responder(request) : responder;
  if (value instanceof Error) throw value;
  return value;
};

const pickResponder = (responder, consumed) =>
  Array.isArray(responder) ? responder[Math.min(consumed, responder.length - 1)] : responder;

export const createFakeOpenAI = () => {
  let responder = DEFAULT_RESPONSE;
  let consumed = 0;
  const state = {
    calls: [],
    callClients: [],
    constructed: [],
    respondWith: (x) => {
      responder = x;
      consumed = 0;
    },
  };

  class OpenAI {
    constructor(options) {
      this.options = options;
      state.constructed.push(options);
      this.chat = { completions: { create: (request) => this.#complete(request) } };
      this.embeddings = { create: async ({ input }) => this.#embed(input) };
    }

    async #complete(request) {
      state.calls.push(request);
      state.callClients.push(this.options);
      const content = resolveResponse(pickResponder(responder, consumed++), request);
      return { choices: [{ message: { content } }] };
    }

    #embed(input) {
      const inputs = Array.isArray(input) ? input : [input];
      return { data: inputs.map((text) => ({ embedding: fakeEmbed(text) })) };
    }
  }

  return { OpenAI, state };
};
