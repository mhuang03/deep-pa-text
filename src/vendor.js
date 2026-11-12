// The only place real third-party constructors are collected (and the documented exception
// that may import discord.js outside discord/ and bot/).
import { Client } from 'discord.js';
import { ChromaClient } from 'chromadb';
import { OpenAIEmbeddingFunction } from '@chroma-core/openai';
import OpenAI from 'openai';
import { GiphyFetch } from '@giphy/js-fetch-api';

// Lazy so a global fetch mock installed before or after construction is honoured.
const lazyFetch = (...args) => globalThis.fetch(...args);

export const createVendor = () => ({
  Client,
  ChromaClient,
  OpenAIEmbeddingFunction,
  OpenAI,
  GiphyFetch,
  fetch: lazyFetch,
});
