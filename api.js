import { loadEnvFile } from 'node:process';
loadEnvFile('.env');

import OpenAI from 'openai';
import { GiphyFetch } from '@giphy/js-fetch-api';
import { semanticSearch, randomSearch } from './db.js';
import { SYSTEM_PROMPT, ragInput, contextlessInput } from './prompt.js';
import { USERNAME_TO_NAME } from './data.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const fetchEmbedding = async (text) => {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-large',
    input: text,
    dimensions: 512,
  });
  return new Float32Array(response.data[0].embedding);
}

const fetchEmbeddings = async (texts) => {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-large',
    input: texts,
    dimensions: 512,
  });
  return response.data.map(d => new Float32Array(d.embedding));
}



const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

export const getRAGResponse = async (respondingAuthor, msg) => {
  const searchResult = await semanticSearch(respondingAuthor, msg);
  const ragPrompt = ragInput(respondingAuthor, USERNAME_TO_NAME[respondingAuthor], msg.content, ...searchResult);
  const response = await deepseek.chat.completions.create({
    model: 'deepseek-v4-flash',
    thinking: {"type": "enabled"},
    stream: false,
    messages: [
      {role: 'system', content: SYSTEM_PROMPT},
      {role: 'user', content: ragPrompt},
    ],
  });
  return response.choices[0].message.content;
}

export const getRandomResponse = async (respondingAuthor) => {
  const other_context = await randomSearch(respondingAuthor);
  const prompt = contextlessInput(respondingAuthor, USERNAME_TO_NAME[respondingAuthor], other_context);
  const response = await deepseek.chat.completions.create({
    model: 'deepseek-v4-flash',
    thinking: {"type": "enabled"},
    stream: false,
    messages: [
      {role: 'system', content: SYSTEM_PROMPT},
      {role: 'user', content: prompt},
    ],
  });
  return response.choices[0].message.content;
}



const gf = new GiphyFetch(process.env.GIPHY_API_KEY);

export const processGIFs = async (text) => {
  let gifLinks = [];
  let matches = [...text.matchAll(/<gif!(.*?)>/g)].map(async (match) => {
    let searchText = match[1].trim().slice(0, 50);
    const { data: gifs } = await gf.search(searchText, { limit: 1 });
    gifLinks.push({ match: match[0], url: gifs[0]?.images?.original?.url || '' });
  });
  await Promise.all(matches);

  return {
    content: text.replace(/<gif!(.*?)>/g, '').trim(),
    gifLinks,
  };
}