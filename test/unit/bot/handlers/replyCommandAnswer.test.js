import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer } from '../../../../src/bot/handlers/replyCommandAnswer.js';
import { GENERATION_FAILED_MESSAGE } from '../../../../src/discord/replyModal.js';
import { loadConfig } from '../../../../src/config.js';

const setup = ({ begin = { allowed: true }, respondError = null, selected = 'bob' } = {}) => {
  const events = [];
  const errors = [];
  const edits = [];
  const modalInteraction = {
    fields: { getStringSelectValues: () => [selected] },
    reply: async (payload) => events.push(['refuse', payload.content]),
    deferReply: async () => events.push('defer'),
    editReply: async (payload) => { edits.push(payload); events.push('edit'); },
  };
  const deps = {
    client: { guilds: { fetch: async () => ({ id: 'fetched' }) } },
    config: loadConfig({}),
    personaSelector: { pickReplier: async () => 'carol' },
    responder: {
      respond: async (request) => {
        events.push(['respond', request.trigger, request.persona, request.via.type]);
        if (respondError) throw respondError;
        request.onDelivered();
        return { response: 'text' };
      },
    },
    delivery: { placeholder: async ({ persona }) => ({ content: `as ${persona}` }), deferOptions: () => ({ flags: 64 }) },
    replyPolicy: { noteReply: (arg) => events.push(['noteReply', arg]) },
    commandLimiter: { begin: () => begin, end: () => events.push('end') },
    logger: { info: (line) => events.push(['info', line]), error: (...a) => errors.push(a) },
  };
  const interaction = { user: { id: 'u', username: 'dave' } };
  const prepared = {
    target: { id: 't', author: 'alice', content: 'hi', timestamp: 1 }, channel: { id: 'c' },
    message: { guild: { id: 'g' }, guildId: 'g' },
  };
  return { deps, interaction, modalInteraction, prepared, events, errors, edits };
};

test('a refused begin answers ephemerally and does not defer or end', async () => {
  const { deps, interaction, modalInteraction, prepared, events } = setup({ begin: { allowed: false, reason: 'busy' } });
  await answer(deps, { interaction, modalInteraction, prepared });
  assert.equal(events[0][0], 'refuse');
  assert.equal(events.includes('defer'), false);
  assert.equal(events.includes('end'), false);
});

test('a successful answer defers, edits the placeholder, responds as the chosen persona and releases', async () => {
  const { deps, interaction, modalInteraction, prepared, events, edits } = setup();
  await answer(deps, { interaction, modalInteraction, prepared });
  assert.deepEqual(events.filter((e) => typeof e === 'string' || e[0] !== 'info'), [
    'defer', 'edit', ['respond', 'command', 'bob', 'interaction'], ['noteReply', { resetMisses: false }], 'end',
  ]);
  assert.deepEqual(edits[0], { content: 'as bob' });
  assert.equal(events.filter((e) => e[0] === 'info').length, 2);
});

test('the random choice is resolved by the persona selector', async () => {
  const { deps, interaction, modalInteraction, prepared, events } = setup({ selected: 'random' });
  await answer(deps, { interaction, modalInteraction, prepared });
  assert.ok(events.some((e) => e[0] === 'respond' && e[2] === 'carol'));
});

test('a failed response tells the user, rethrows and still releases the limiter', async () => {
  const { deps, interaction, modalInteraction, prepared, events, edits } = setup({ respondError: new Error('llm down') });
  await assert.rejects(answer(deps, { interaction, modalInteraction, prepared }), /llm down/);
  assert.equal(edits.at(-1).content, GENERATION_FAILED_MESSAGE);
  assert.equal(events.at(-1), 'end');
});

test('a failing failure notice is logged and the original error still propagates', async () => {
  const { deps, interaction, modalInteraction, prepared, errors } = setup({ respondError: new Error('llm down') });
  let first = true;
  modalInteraction.editReply = async () => {
    if (first) { first = false; return; }
    throw new Error('edit failed');
  };
  await assert.rejects(answer(deps, { interaction, modalInteraction, prepared }), /llm down/);
  assert.match(errors[0][0], /Could not report the failed reply/);
});
