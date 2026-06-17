import { loadEnvFile } from 'node:process';
loadEnvFile('.env');

import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { ChromaClient } from 'chromadb';
import { OpenAIEmbeddingFunction } from "@chroma-core/openai";
import { filter } from './filter.js';



const message_db = new DatabaseSync('messages.db');

message_db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    reference TEXT
  )
`);

message_db.exec(`
  CREATE TABLE IF NOT EXISTS filtered_messages (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    reference TEXT,
    has_gif BOOLEAN NOT NULL,

    CONSTRAINT fk_reference FOREIGN KEY (reference) REFERENCES filtered_messages(id) ON DELETE SET NULL
  )
`);

message_db.exec(`
  CREATE INDEX IF NOT EXISTS idx_filtered_messages_timestamp ON filtered_messages (timestamp)
`);



const insertMessageSQL = message_db.prepare(`
  INSERT INTO messages (id, author, content, timestamp, reference)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`);
const insertMessage = (msg) => {
  insertMessageSQL.run(msg.id, msg.author, msg.content, msg.timestamp, msg.reference);
};



const insertFilteredMessageSQL = message_db.prepare(`
  INSERT INTO filtered_messages (id, author, content, timestamp, reference, has_gif)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`);
const getPreviousFilteredMessageSQL = message_db.prepare(`
  SELECT * FROM filtered_messages
  WHERE timestamp < ?
  ORDER BY timestamp DESC
  LIMIT 1
`);
const existsIdFilteredMessageSQL = message_db.prepare(`
  SELECT 1 as id_exists FROM filtered_messages WHERE id = ?
`);
const insertFilteredMessage = (f_msg) => {
  const hasGif = f_msg.content.includes('<gif!') ? 1 : 0;
  let reference = f_msg.reference;

  // if there is a reference, check if it exists in filtered_messages, and if not set reference to null
  if (reference) {
    const referenced = existsIdFilteredMessageSQL.get(reference);
    if (!referenced) {
      reference = null;
    }
  }

  // if reference is null, and the previous (time-wise) filtered message is from a different author and within an hour ago, set reference to that message
  if (!reference) {
    const previous = getPreviousFilteredMessageSQL.get(f_msg.timestamp);
    if (previous && previous.author !== f_msg.author && (f_msg.timestamp - previous.timestamp) < 3600000) {
      reference = previous.id;
    }
  }

  insertFilteredMessageSQL.run(f_msg.id, f_msg.author, f_msg.content, f_msg.timestamp, reference, hasGif);
};



const chromaClient = new ChromaClient({
  port: 7429,
});
await chromaClient.heartbeat();

const emFun = new OpenAIEmbeddingFunction({
    apiKeyEnvVar: 'OPENAI_API_KEY',
    modelName: 'text-embedding-3-small',
    dimensions: 512,
  });

const messageEmbeddings = await chromaClient.getOrCreateCollection({
  name: 'message_embeddings',
  embeddingFunction: emFun,
});

// stores messages under the embedding of the message they reply to
const messageReplyEmbeddings = await chromaClient.getOrCreateCollection({
  name: 'message_reply_embeddings',
  embeddingFunction: emFun,
});

const insertEmbeddings = async (msgs) => {
  await messageEmbeddings.upsert({
    ids: msgs.map(m => m.id),
    documents: msgs.map(m => m.content),
    metadatas: msgs.map(m => ({ author: m.author, timestamp: m.timestamp, has_gif: m.hasGif })),
  });

  const withReference = msgs.filter(m => m.reference);
  const dedupedReferenceIds = Array.from(new Set(withReference.map(m => m.reference)));
  if (dedupedReferenceIds.length === 0) return;
  const referenced = await messageEmbeddings.get({ ids: dedupedReferenceIds, include: ['embeddings'] });
  if (referenced.ids.length === 0) return;
  const referencedIdMap = new Map(
    referenced.ids.map((id, index) => [id, referenced.embeddings[index]])
  );

  await messageReplyEmbeddings.upsert({
    ids: withReference.map(m => m.id),
    documents: withReference.map(m => m.content),
    metadatas: withReference.map(m => ({ author: m.author, timestamp: m.timestamp, has_gif: m.hasGif })),
    embeddings: withReference.map(m => {
      return referencedIdMap.get(m.reference);
    }),
  });
};

const insertEmbedding = async (msg) => {
  await insertEmbeddings([msg]);
};



export const recordMessage = async (msg) => {
  insertMessage(msg);
  const filtered = filter(msg);
  if (filtered) {
    insertFilteredMessage(filtered);
    await insertEmbedding(filtered);
  }
  return `[${new Date(msg.timestamp).toLocaleString('en-US', { timeZone: 'America/Chicago' })}] ${msg.author}: ${msg.content}`
    + `\n  [filter kept: ${filtered ? 'yes' : 'no'}] (reference: ${msg.reference})`;
};



export const semanticSearch = async (author, msg) => {
  const embedding = await emFun.generate([msg.content]);
  const in_context = await messageEmbeddings.query({
    queryEmbeddings: embedding,
    nResults: 20,
    where: { $and: [{ author }, { timestamp: { $lt: msg.timestamp } }] },
    include: ["documents"],
  });
  const in_reply_context = await messageReplyEmbeddings.query({
    queryEmbeddings: embedding,
    nResults: 10,
    where: { $and: [{ author }, { timestamp: { $lt: msg.timestamp } }] },
    include: ["documents"],
  });
  const gif_context = await messageEmbeddings.query({
    queryEmbeddings: embedding,
    nResults: 10,
    where: { $and: [{ author }, { timestamp: { $lt: msg.timestamp } }, { has_gif: true }] },
    include: ["documents"],
  });
  const other_context = message_db.prepare(`
    SELECT content FROM filtered_messages
    WHERE author = ? AND timestamp < ?
    ORDER BY RANDOM()
    LIMIT 10
  `).all(author, msg.timestamp);

  // dedup results; since all messages are from the same author, we can just dedup based on content.
  // earlier sets take precedence over later sets, so that in_reply_context > in_context > gif_context > other_context in terms of precedence when deduping.
  const results = [
    new Set(in_reply_context.documents[0]),
    new Set(in_context.documents[0]),
    new Set(gif_context.documents[0]),
    new Set(other_context.map(m => m.content)),
  ];
  for (let i = 1; i < results.length; i++) {
    for (let j = 0; j < i; j++) {
      results[i] = results[i].difference(results[j]);
    }
  }
  return results.map(s => Array.from(s));
};



// grab 50 completely random messages without context
export const randomSearch = async (author) => {
  const other_context = message_db.prepare(`
    SELECT content FROM filtered_messages
    WHERE author = ?
    ORDER BY RANDOM()
    LIMIT 50
  `).all(author);
  return other_context.map(m => m.content);
};



export const searchLikelyRepliers = async (msg) => {
  const repliers = await messageReplyEmbeddings.query({
    queryTexts: [msg.content],
    nResults: 20,
    where: { $and: [{ author: { $ne: msg.author } }, { timestamp: { $lt: msg.timestamp } }] },
    include: ["metadatas"],
  });
  return repliers.metadatas[0].map(m => m.author);
};



if (import.meta.main) {
  // print out latest 10 messages and the latest 10 filtered messages
  console.log('Latest messages:');
  message_db.prepare(`
    SELECT * FROM messages
    ORDER BY timestamp DESC
    LIMIT 10
  `).all().forEach(m => {
    console.log(`[${new Date(m.timestamp).toLocaleString('en-US', { timeZone: 'America/Chicago' })}] ${m.author}: ${m.content} (reference: ${m.reference})`);
  });

  console.log('Latest filtered messages:');
  message_db.prepare(`
    SELECT * FROM filtered_messages
    ORDER BY timestamp DESC
    LIMIT 10
  `).all().forEach(m => {
    console.log(`[${new Date(m.timestamp).toLocaleString('en-US', { timeZone: 'America/Chicago' })}] ${m.author}: ${m.content} (has_gif: ${m.has_gif}, reference: ${m.reference})`);
  });

  // print out latest 10 filtered messages that have a reference, and the message they reference
  console.log('Latest filtered messages with reference:');
  message_db.prepare(`
    SELECT m.*, r.content as reference_content FROM filtered_messages m
    JOIN filtered_messages r ON m.reference = r.id
    ORDER BY m.timestamp DESC
    LIMIT 10
  `).all().forEach(m => {
    console.log(`[${new Date(m.timestamp).toLocaleString('en-US', { timeZone: 'America/Chicago' })}] ${m.author}: ${m.content} (references: ${m.reference_content})`);
  });

  // print out latest 10 filtered messages that have a gif, and the number of messages that have a gif
  console.log('Latest filtered messages with gif:');
  message_db.prepare(`
    SELECT * FROM filtered_messages
    WHERE has_gif = 1
    ORDER BY timestamp DESC
    LIMIT 10
  `).all().forEach(m => {
    console.log(`[${new Date(m.timestamp).toLocaleString('en-US', { timeZone: 'America/Chicago' })}] ${m.author}: ${m.content} (has_gif: ${m.has_gif})`);
  });

  // // peek chromadb collections
  // console.log('Peeking messageEmbeddings:');
  // console.log(await messageEmbeddings.peek({limit: 10}));
  // console.log('Peeking messageReplyEmbeddings:');
  // console.log(await messageReplyEmbeddings.peek({limit: 10}));

  // // print out 10 messages from chromadb that have has_gif = true in metadata
  // console.log('Messages with has_gif = true in messageEmbeddings:');
  // console.log(await messageEmbeddings.get({ where: { has_gif: true }, limit: 10 }));
  // console.log('Messages with has_gif = true in messageReplyEmbeddings:');
  // console.log(await messageReplyEmbeddings.get({ where: { has_gif: true }, limit: 10 }));

  // // test semantic search with example message
  // const testMsg = {
  //   id: "1515906897847259260",
  //   author: "stickfr",
  //   timestamp: 1781490768635,
  //   content: 'How long yall gonna be in gc',
  // };
  // console.log('Semantic search results:');
  // console.log(await semanticSearch('stickfr', testMsg));
}