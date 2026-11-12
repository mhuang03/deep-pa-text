const DIMENSIONS = 64;

const fnv1a32 = (text) => {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
};

export const fakeEmbed = (text) => {
  const vector = new Array(DIMENSIONS).fill(0);
  const tokens = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return Object.assign(vector, { 0: 1 });
  tokens.forEach((token) => {
    vector[fnv1a32(token) % DIMENSIONS] += 1;
  });
  const norm = Math.hypot(...vector);
  return vector.map((x) => x / norm);
};

const squaredDistance = (a, b) => a.reduce((sum, x, i) => sum + (x - b[i]) ** 2, 0);

const OPERATORS = {
  $eq: (value, operand) => value === operand,
  $ne: (value, operand) => value !== operand,
  $lt: (value, operand) => value < operand,
  $lte: (value, operand) => value <= operand,
  $gt: (value, operand) => value > operand,
  $gte: (value, operand) => value >= operand,
  $in: (value, operand) => operand.includes(value),
  $nin: (value, operand) => !operand.includes(value),
};
const PASSES_WHEN_MISSING = new Set(['$ne', '$nin']);

const isOperatorObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

const matchField = (metadata, field, condition) => {
  const conditions = isOperatorObject(condition) ? condition : { $eq: condition };
  const value = metadata[field];
  return Object.entries(conditions).every(([op, operand]) => {
    if (!OPERATORS[op]) throw new Error(`fake chroma: unsupported operator ${op}`);
    if (value === undefined) return PASSES_WHEN_MISSING.has(op);
    return OPERATORS[op](value, operand);
  });
};

export const matchesWhere = (metadata, where) =>
  Object.entries(where ?? {}).every(([key, condition]) => {
    if (key === '$and') return condition.every((w) => matchesWhere(metadata, w));
    if (key === '$or') return condition.some((w) => matchesWhere(metadata, w));
    return matchField(metadata, key, condition);
  });

const cleanMetadata = (metadata) =>
  Object.fromEntries(Object.entries(metadata ?? {}).filter(([, v]) => v !== undefined));

const FIELD_KEYS = { documents: 'document', metadatas: 'metadata', embeddings: 'embedding' };

const project = (entries, include) =>
  Object.fromEntries(
    Object.entries(FIELD_KEYS)
      .filter(([name]) => include.includes(name))
      .map(([name, key]) => [name, entries.map((entry) => entry[key])]),
  );

const createCollection = (name, embeddingFunction, onEmbed, failure = null) => {
  const embedder = embeddingFunction ?? {
    generate: async (texts) => {
      onEmbed();
      return texts.map(fakeEmbed);
    },
  };
  const guard = () => {
    if (failure) throw failure;
  };

  const collection = {
    name,
    rows: new Map(),
    upserts: [],
    queries: [],
    setFailing: (error) => {
      failure = error ?? null;
    },
    seed: (records) => {
      records.forEach(({ id, document, metadata, embedding }) => {
        collection.rows.set(id, {
          id,
          document,
          metadata: cleanMetadata(metadata),
          embedding: embedding ?? fakeEmbed(document),
        });
      });
    },
    async upsert(args) {
      guard();
      collection.upserts.push(args);
      const embeddings = args.embeddings ?? (await embedder.generate(args.documents));
      collection.seed(args.ids.map((id, i) => {
        if (!embeddings[i]) throw new Error(`fake chroma: no embedding for ${id}`);
        return { id, document: args.documents[i], metadata: args.metadatas?.[i], embedding: [...embeddings[i]] };
      }));
    },
    async get({ ids, include = ['documents', 'metadatas'] }) {
      guard();
      const found = ids.filter((id) => collection.rows.has(id));
      return { ids: found, ...project(found.map((id) => collection.rows.get(id)), include) };
    },
    async query(args) {
      guard();
      collection.queries.push(args);
      const { queryEmbeddings, queryTexts, nResults = 10, where } = args;
      const include = args.include ?? ['documents', 'metadatas', 'distances'];
      const vectors = queryEmbeddings ?? (await embedder.generate(queryTexts));
      const perQuery = vectors.map((vector) => rank(collection.rows, vector, where, nResults));
      return {
        ids: perQuery.map((hits) => hits.map((hit) => hit.id)),
        ...mergeProjections(perQuery.map((hits) => project(hits, include))),
        ...(include.includes('distances') && { distances: perQuery.map((hits) => hits.map((h) => h.distance)) }),
      };
    },
  };
  return collection;
};

const rank = (rows, vector, where, limit) =>
  [...rows.values()]
    .filter((row) => matchesWhere(row.metadata, where))
    .map((row) => ({ ...row, distance: squaredDistance(row.embedding, vector) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);

const mergeProjections = (projections) => {
  const names = Object.keys(projections[0] ?? {});
  return Object.fromEntries(names.map((name) => [name, projections.map((p) => p[name])]));
};

export const createFakeChroma = () => {
  const collections = new Map();
  // Failures armed by name, applied when the collection is created (a generation's name is not known earlier).
  const armed = new Map();
  let heartbeatError = null;
  const embeddingFunctions = [];
  const state = {
    constructed: [],
    // Number of embedding-function generate calls, to prove a repair did not re-embed anything.
    embeddingCalls: 0,
    embeddingFunctions,
    get embeddingFunctionOptions() {
      return embeddingFunctions.at(-1) ?? null;
    },
    failCollection: (name, error) => {
      armed.set(name, error ?? null);
      collections.get(name)?.setFailing(error);
    },
    failHeartbeat: (error) => {
      heartbeatError = error ?? null;
    },
    collection: (name) => {
      if (!collections.has(name)) throw new Error(`fake chroma: collection not created: ${name}`);
      return collections.get(name);
    },
  };

  class OpenAIEmbeddingFunction {
    constructor(options) {
      embeddingFunctions.push(options);
    }

    async generate(texts) {
      state.embeddingCalls += 1;
      return texts.map(fakeEmbed);
    }
  }

  class ChromaClient {
    constructor(options) {
      state.constructed.push(options);
    }

    async heartbeat() {
      if (heartbeatError) throw heartbeatError;
      return 1;
    }

    async getOrCreateCollection({ name, embeddingFunction }) {
      if (!collections.has(name)) collections.set(name, createCollection(name, embeddingFunction, () => {
        state.embeddingCalls += 1;
      }, armed.get(name) ?? null));
      return collections.get(name);
    }
  }

  return { ChromaClient, OpenAIEmbeddingFunction, state };
};
