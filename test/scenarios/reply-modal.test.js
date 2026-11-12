import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { MODAL_TIMEOUT_LOG } from '../../src/discord/replyModal.js';

const TARGET_A = 'alice wrote about gardening tools';
const TARGET_B = 'bob wrote about fishing boats';

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const promptsMention = (world, text) =>
  world.llm.calls.filter((call) => JSON.stringify(call).includes(text)).length;

const open = (world, content, user) => world.openReplyCommand({ target: { content }, user });

test('only the submitting user flow runs when two users have the modal open', async (t) => {
  const world = await newWorld(t);
  const a = await open(world, TARGET_A, 'alice');
  const b = await open(world, TARGET_B, 'bob');
  const submittedB = await b.submit({ author: 'carol' });
  assert.equal(submittedB.deferrals.length, 1);
  assert.equal(world.llm.calls.length, 1);
  assert.equal(promptsMention(world, TARGET_B), 1);
  assert.equal(promptsMention(world, TARGET_A), 0);
  assert.equal(a.replies.length, 0);
});

test('the other user wait stays pending and their later submit runs their own flow', async (t) => {
  const world = await newWorld(t);
  const a = await open(world, TARGET_A, 'alice');
  const b = await open(world, TARGET_B, 'bob');
  await b.submit({ author: 'carol' });
  const submittedA = await a.submit({ author: 'dave' });
  assert.equal(submittedA.deferrals.length, 1);
  assert.equal(submittedA.edits.length, 2);
  assert.equal(promptsMention(world, TARGET_A), 1);
  assert.equal(world.llm.calls.length, 2);
  assert.deepEqual(world.errors, []);
});

test('the same user with two modals open resolves each submit only for its own interaction', async (t) => {
  const world = await newWorld(t, { config: { command: { userCooldownMs: 0 } } });
  const first = await open(world, TARGET_A, 'alice');
  const second = await open(world, TARGET_B, 'alice');
  assert.notEqual(first.modal.custom_id, second.modal.custom_id);
  await second.submit({ author: 'carol' });
  assert.equal(world.llm.calls.length, 1);
  assert.equal(promptsMention(world, TARGET_B), 1);
  await first.submit({ author: 'dave' });
  assert.equal(world.llm.calls.length, 2);
  assert.equal(promptsMention(world, TARGET_A), 1);
});

test('a submission with a foreign custom id is ignored and the wait stays pending', async (t) => {
  const world = await newWorld(t);
  const a = await open(world, TARGET_A, 'alice');
  const ignored = await a.submit({ author: 'bob', customId: 'someOtherModal' });
  assert.deepEqual([ignored.replies, ignored.edits, world.llm.calls], [[], [], []]);
  const accepted = await a.submit({ author: 'bob' });
  assert.equal(accepted.deferrals.length, 1);
});

test('a submission from another user is ignored and the wait stays pending', async (t) => {
  const world = await newWorld(t);
  const a = await open(world, TARGET_A, 'alice');
  const ignored = await a.submit({ author: 'bob', user: { id: 'user-mallory', username: 'mallory' } });
  assert.deepEqual([ignored.replies, ignored.edits, world.llm.calls], [[], [], []]);
  const accepted = await a.submit({ author: 'bob' });
  assert.equal(accepted.deferrals.length, 1);
});

test('a timeout sends nothing and is logged as info, not as an error', async (t) => {
  const world = await newWorld(t);
  const a = await open(world, TARGET_A, 'alice');
  await a.timeout();
  assert.equal(a.replies.length, 0);
  assert.equal(world.discord.channel.sent.length, 0);
  assert.ok(world.logs.log.some((args) => args.includes(MODAL_TIMEOUT_LOG)));
  assert.deepEqual(world.logs.error, []);
  assert.deepEqual(world.errors, []);
});

test('a submit after the wait timed out has no effect', async (t) => {
  const world = await newWorld(t);
  const a = await open(world, TARGET_A, 'alice');
  await a.timeout();
  const late = await a.submit({ author: 'bob' });
  assert.deepEqual([late.replies, late.edits, world.llm.calls], [[], [], []]);
});

test('a submit after the wait already resolved has no effect', async (t) => {
  const world = await newWorld(t);
  const a = await open(world, TARGET_A, 'alice');
  await a.submit({ author: 'bob' });
  const again = await a.submit({ author: 'bob' });
  assert.deepEqual([again.replies, again.edits], [[], []]);
  assert.equal(world.llm.calls.length, 1);
});

test('any other awaitModalSubmit rejection is logged once as an error and sends nothing', async (t) => {
  const world = await newWorld(t);
  const { makeMessage, makeReplyCommand } = world.fakes.discord;
  const a = makeReplyCommand({ target: makeMessage({ content: TARGET_A }) });
  a.awaitModalSubmit = async () => {
    throw new Error('discord exploded');
  };
  await world.emitInteraction(a);
  assert.equal(world.logs.error.length, 1);
  assert.equal(a.replies.length, 0);
  assert.equal(world.discord.channel.sent.length, 0);
  assert.equal(world.llm.calls.length, 0);
});
