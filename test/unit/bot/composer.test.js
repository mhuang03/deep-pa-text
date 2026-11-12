import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposer } from '../../../src/bot/composer.js';
import { createAuthorEmbeds } from '../../../src/discord/authorEmbed.js';
import { loadConfig } from '../../../src/config.js';
import { createFakeDiscord } from '../../support/fakes/discord.js';

const setup = ({ links = [], text = 'hello' } = {}) => {
  const { state } = createFakeDiscord();
  const calls = [];
  const generator = {
    generateReply: async (persona, record) => {
      calls.push(['reply', persona, record]);
      return `reply ${text}`;
    },
    generateRevive: async (persona) => {
      calls.push(['revive', persona]);
      return `revive ${text}`;
    },
  };
  const gifResolver = {
    resolve: async (response) => {
      calls.push(['resolve', response]);
      return { content: `resolved ${response}`, gifLinks: links };
    },
  };
  const authorEmbeds = createAuthorEmbeds({ config: loadConfig({}), logger: { warn: () => {} } });
  const composer = createComposer({ generator, gifResolver, authorEmbeds });
  return { composer, calls, guild: state.guild };
};

const json = (embed) => JSON.parse(JSON.stringify(embed.toJSON()));

test('composeReply generates, resolves GIFs, then builds the payload', async () => {
  const { composer, calls, guild } = setup({ links: [{ match: '<gif! a>', url: 'https://g.example/a.gif' }] });
  const record = { id: '1', author: 'alice', content: 'hi there', timestamp: 5, reference: null };
  const { response, payload } = await composer.composeReply({ persona: 'bob', record, guild });
  assert.equal(response, 'reply hello');
  assert.deepEqual(calls, [['reply', 'bob', record], ['resolve', 'reply hello']]);
  assert.equal(payload.content, 'resolved reply hello');
  assert.equal(payload.embeds.length, 2);
  assert.equal(json(payload.embeds[0]).image.url, 'https://g.example/a.gif');
  assert.equal(json(payload.embeds[1]).author.name, 'bob');
  assert.equal(json(payload.embeds[1]).footer, undefined);
});

test('composeReply omits unresolved links and keeps only the author embed', async () => {
  const { composer, guild } = setup({ links: [{ match: '<gif! a>', url: '' }] });
  const { payload } = await composer.composeReply({ persona: 'bob', record: {}, guild });
  assert.equal(payload.embeds.length, 1);
});

test('composeRevive uses the revive generator and the persona embed', async () => {
  const { composer, calls, guild } = setup();
  const { response, payload } = await composer.composeRevive({ persona: 'carol', guild });
  assert.equal(response, 'revive hello');
  assert.deepEqual(calls, [['revive', 'carol'], ['resolve', 'revive hello']]);
  assert.equal(json(payload.embeds.at(-1)).author.name, 'carol');
  assert.deepEqual(guild.members.calls, [{ query: 'carol', limit: 1 }]);
});

test('propagates generator errors without resolving GIFs', async () => {
  const { composer, calls, guild } = setup();
  const failing = createComposer({
    generator: { generateReply: async () => { throw new Error('llm down'); } },
    gifResolver: { resolve: async () => calls.push('resolve') },
    authorEmbeds: { make: async () => calls.push('embed') },
  });
  await assert.rejects(failing.composeReply({ persona: 'bob', record: {}, guild }), /llm down/);
  assert.deepEqual(calls, []);
});
