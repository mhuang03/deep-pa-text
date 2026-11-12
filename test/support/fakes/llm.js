import { fakeEmbed } from './chroma.js';
import { parkWhile } from './parking.js';

const DEFAULT_RESPONSE = 'ok cool';

const resolveResponse = (responder, request) => {
  const value = typeof responder === 'function' ? responder(request) : responder;
  if (value instanceof Error) throw value;
  return value;
};

const isRawCompletion = (value) =>
  value !== null && typeof value === 'object' && 'choices' in value;

// null, '' and strings become message content; an object with `choices` is returned verbatim.
const toCompletion = (value) => (isRawCompletion(value) ? value : { choices: [{ message: { content: value } }] });

const pickResponder = (responder, consumed) =>
  Array.isArray(responder) ? responder[Math.min(consumed, responder.length - 1)] : responder;

export const createFakeOpenAI = () => {
  let responder = DEFAULT_RESPONSE;
  let consumed = 0;
  const holds = [];
  const open = new Set();
  const state = {
    calls: [],
    callClients: [],
    constructed: [],
    // The next completion waits until the returned function is called; its handler is parked meanwhile.
    hold: () => {
      let release;
      const gate = new Promise((resolve) => {
        release = () => {
          open.delete(release);
          resolve();
        };
      });
      open.add(release);
      holds.push(gate);
      return release;
    },
    releaseAll: () => [...open].forEach((release) => release()),
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
      const gate = holds.shift();
      if (gate) await parkWhile(() => gate);
      // A responder function may return a promise, so a test can hold a completion open.
      const content = await resolveResponse(pickResponder(responder, consumed++), request);
      return toCompletion(content);
    }

    #embed(input) {
      const inputs = Array.isArray(input) ? input : [input];
      return { data: inputs.map((text) => ({ embedding: fakeEmbed(text) })) };
    }
  }

  return { OpenAI, state };
};
