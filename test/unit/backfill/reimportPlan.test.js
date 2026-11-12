import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReimportPlan } from '../../../src/backfill/reimportPlan.js';

const BOT_ID = 'bot1';
const human = (id, content) => ({
  id, content, author: { id: `u-${id}`, username: 'alice', bot: false }, webhookId: null,
  createdTimestamp: 1000, reference: null, attachments: new Map(), embeds: [], stickers: new Map(),
});
const bot = (id, author = { id: BOT_ID, bot: true, username: 'pa' }, webhookId = null) => ({ ...human(id, 'x'), author, webhookId });

const setup = ({ owned = new Set(), known = new Set(), webhookError = null } = {}) => {
  const warnings = [];
  const plan = createReimportPlan({
    messageFilter: { filter: (record) => (record.content.length >= 5 ? record : null) },
    webhooks: { ownedIds: async () => { if (webhookError) throw webhookError; return owned; } },
    getBotUserId: () => BOT_ID,
    logger: { warn: (...args) => warnings.push(args) },
  });
  const archive = { botMessage: (id) => (known.has(id) ? { persona: 'alice' } : null) };
  return { plan, archive, warnings };
};

test('classifies humans, own bot messages and other bots, and counts what the filter keeps', async () => {
  const { plan, archive } = setup({ owned: new Set(['hook1']), known: new Set(['k1']) });
  const messages = [
    human('1', 'long enough text'), human('2', 'no'), bot('3'), bot('4', { id: 'w', bot: true, username: 'w' }, 'hook1'),
    human('k1', 'known bot message text'), bot('5', { id: 'other', bot: true, username: 'o' }),
  ];
  const result = await plan.plan(messages, { channel: { id: 'c' }, archive });
  assert.deepEqual(result, { fetched: 6, humans: 2, ownBot: 3, otherBots: 1, wouldKeep: 1 });
});

test('still plans when the bot webhooks cannot be listed', async () => {
  const { plan, archive, warnings } = setup({ webhookError: new Error('denied') });
  const result = await plan.plan([human('1', 'long enough text')], { channel: { id: 'c' }, archive });
  assert.equal(result.humans, 1);
  assert.equal(warnings.length, 1);
});
