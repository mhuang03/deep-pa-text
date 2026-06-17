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
const giphy = {
  search: async (searchText) => {
    const { data: gifs } = await gf.search(searchText, { limit: 1 });
    return gifs[0]?.images?.original?.url || '';
  }
}

const humor = {
  search: async (searchText) => {
    let url = 'https://api.humorapi.com/gif/search';
    let params = new URLSearchParams({
      "api-key": process.env.HUMOR_API_KEY,
      number: 1,
      query: searchText,
    });
    const response = await fetch(url + '?' + params.toString());
    const data = await response.json();
    return data.images[0]?.url || '';
  }
}

const klipy = {
  search: async (searchText) => {
    let url = `https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/gifs/search`;
    let params = new URLSearchParams({
      page: 1,
      per_page: 8,
      q: searchText,
      customer_id: 'deep-pa-text',
      locale: 'us',
      content_filter: 'off',
      format_filter: 'gif',
    });
    const response = await fetch(url + '?' + params.toString());
    const data = await response.json();
    return data.data?.data[0]?.file.hd.gif.url || '';
  }
}

const searchEngines = [klipy, giphy, humor];

export const processGIFs = async (text) => {
  let gifLinks = [];
  let matches = [...text.matchAll(/<gif!(.*?)>/g)].map(async (match) => {
    let searchText = match[1].trim().slice(0, 50);

    let url = '';
    for (let engine of searchEngines) {
      url = await engine.search(searchText);
      if (url !== '') break;
    }

    gifLinks.push({ match: match[0], url });
  });
  await Promise.all(matches);

  let content = text;
  gifLinks.forEach(({ match, url }) => {
    if (url) {
      content = content.replace(match, '');
    } else {
      content = content.replace(match, '<INSERT GIF: ' + match.slice(5));
    }
  });

  return {
    content,
    gifLinks,
  };
}