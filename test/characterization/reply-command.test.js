import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createWorld } from '../support/world.js';
import { GENERATION_FAILED_MESSAGE } from '../../src/discord/replyModal.js';
import { BASE_TIME, OTHER_CHANNEL_ID, GUILD_ID, USERS } from '../support/fixtures.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const CONTENT = 'hello there friends';
const BLURPLE = 0x5865f2;

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

// carol and dave each replied to alice's message, so both are "likely repliers" (carol first)
const seedRepliers = (world) =>
  world.seed([
    { id: 'seed-a', author: 'alice', content: CONTENT, timestamp: BASE_TIME - 100_000, reference: null },
    { id: 'seed-b', author: 'carol', content: 'carol reply here', timestamp: BASE_TIME - 90_000, reference: 'seed-a' },
    { id: 'seed-c', author: 'dave', content: 'dave reply here', timestamp: BASE_TIME - 80_000, reference: 'seed-a' },
  ]);

const openAndSubmit = async (world, author, target = { content: CONTENT }) => {
  const interaction = await world.openReplyCommand({ target });
  const submitted = await interaction.submit({ author });
  return { interaction, submitted };
};

test('ignores an interaction that is not a message context-menu command', async (t) => {
  const world = await newWorld(t);
  const interaction = world.discord.makeInteraction({ commandName: 'reply' });
  await world.emitInteraction(interaction);
  assert.equal(interaction.replies.length, 0);
  assert.equal(world.errors.length, 0);
});

test('ignores a message context-menu command whose name is not reply', async (t) => {
  const world = await newWorld(t);
  const interaction = world.discord.makeInteraction({
    commandName: 'other',
    isMessageContextMenuCommand: () => true,
    targetMessage: world.discord.makeMessage({ content: CONTENT }),
    showModal: async () => assert.fail('modal must not be shown'),
  });
  await world.emitInteraction(interaction);
  assert.equal(interaction.replies.length, 0);
  assert.equal(world.errors.length, 0);
});

test('tells the user an unreplyable target is not replyable and shows no modal', async (t) => {
  const world = await newWorld(t);
  const interaction = await world.openReplyCommand({ target: { content: 'hi' } });
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].content, 'The selected message is not replyable.');
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(interaction.modal, null);
});

test('tells the user the command only works in the pa-text channel for a target elsewhere', async (t) => {
  const world = await newWorld(t);
  const interaction = await world.openReplyCommand({
    target: { content: CONTENT, channel: world.discord.otherChannel },
  });
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].content, 'This command can only be used in the #pa-text channel.');
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(interaction.modal, null);
});

test('reports not replyable before the channel restriction when both apply', async (t) => {
  const world = await newWorld(t);
  const interaction = await world.openReplyCommand({
    target: { content: 'hi', channel: world.discord.otherChannel },
  });
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].content, 'The selected message is not replyable.');
  assert.equal(interaction.modal, null);
});

test('shows a modal with the original message and an author select', async (t) => {
  const world = await newWorld(t);
  const interaction = await world.openReplyCommand({ target: { content: CONTENT, author: 'alice' } });
  const modal = interaction.modal;
  assert.equal(modal.custom_id, `replyModal:${interaction.id}`);
  assert.equal(modal.title, 'Reply using deep pa-text');
  assert.equal(modal.components.length, 2);

  const [display, label] = modal.components;
  assert.equal(display.content, `**Original message from alice:**\n${CONTENT}`);
  assert.equal(label.label, 'Who should I reply as?');
  assert.equal(label.component.custom_id, 'authorSelect');
  assert.equal(label.component.placeholder, 'Select an author');

  const expected = USERS.map((user) => ({
    label: user.username,
    description: `Reply as ${user.name}`,
    value: user.username,
  }));
  expected.push({ label: 'random', description: 'Reply as a random user', value: 'random' });
  const actual = label.component.options.map(({ label: l, description, value }) => ({ label: l, description, value }));
  assert.deepEqual(actual, expected);
});

test('shows the transformed content of the target in the modal', async (t) => {
  const world = await newWorld(t);
  const interaction = await world.openReplyCommand({ target: { content: '<@111> hello there' } });
  assert.equal(interaction.modal.components[0].content, '**Original message from alice:**\n@alice hello there');
});

test('waits up to 120000 ms for the modal submission', async (t) => {
  const world = await newWorld(t);
  const interaction = await world.openReplyCommand({ target: { content: CONTENT } });
  assert.equal(interaction.modalOptions.time, 120_000);
});

test('submitting a named author sends a thinking embed first', async (t) => {
  const world = await newWorld(t);
  const { submitted } = await openAndSubmit(world, 'bob');
  assert.equal(submitted.replies.length, 1);
  const embeds = submitted.replies[0].embeds;
  assert.equal(embeds.length, 1);
  assert.equal(embeds[0].data.author.name, 'bob');
  assert.equal(embeds[0].data.author.icon_url, 'https://cdn.example/avatars/bob.png');
  assert.equal(embeds[0].data.color, BLURPLE);
  assert.equal(embeds[0].data.footer.text, 'thinking...');
});

test('submitting a named author edits the reply with the response and an author embed', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith('sounds good to me');
  const { submitted } = await openAndSubmit(world, 'bob');
  assert.equal(submitted.edits.length, 1);
  const edit = submitted.edits[0];
  assert.equal(edit.content, 'sounds good to me');
  assert.equal(edit.embeds.length, 1);
  assert.equal(edit.embeds[0].data.author.name, 'bob');
  assert.equal(edit.embeds[0].data.author.icon_url, 'https://cdn.example/avatars/bob.png');
  assert.equal(edit.embeds[0].data.color, BLURPLE);
  assert.equal(edit.embeds[0].data.footer, undefined);
});

test('puts GIF embeds before the author embed in the edited reply', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith('nice <gif! cat>');
  world.gifs.klipy.setResult('https://gif.example/cat.gif');
  const { submitted } = await openAndSubmit(world, 'bob');
  const edit = submitted.edits[0];
  assert.equal(edit.embeds.length, 2);
  assert.equal(edit.embeds[0].data.image.url, 'https://gif.example/cat.gif');
  assert.equal(edit.embeds[1].data.author.name, 'bob');
  assert.equal(edit.content, 'nice ');
});

test('makes one LLM call naming the chosen author and the target content', async (t) => {
  const world = await newWorld(t);
  await openAndSubmit(world, 'bob', { content: '<@111> hello there' });
  assert.equal(world.llm.calls.length, 1);
  const prompt = world.llm.calls[0].messages[1].content;
  assert.match(prompt, /username "bob"/);
  assert.match(prompt, /real name is "Bob Example"/);
  assert.match(prompt, /just received the message: "@alice hello there"/);
});

test('does not reply to the target message or send through the channel', async (t) => {
  const world = await newWorld(t);
  const target = world.discord.makeMessage({ content: CONTENT });
  await openAndSubmit(world, 'bob', target);
  assert.equal(target.replies.length, 0);
  assert.equal(world.discord.channel.sent.length, 0);
});

test('random author picks the likely replier selected by the roll', async (t) => {
  const world = await newWorld(t);
  await seedRepliers(world);
  world.setRandom([0]);
  const { submitted } = await openAndSubmit(world, 'random');
  assert.equal(submitted.replies[0].embeds[0].data.author.name, 'carol');
  assert.equal(submitted.edits[0].embeds[0].data.author.name, 'carol');
  assert.equal(world.randomCalls, 1);
});

test('random author indexes into the likely repliers by the roll', async (t) => {
  const world = await newWorld(t);
  await seedRepliers(world);
  world.setRandom([0.99]);
  const { submitted } = await openAndSubmit(world, 'random');
  assert.equal(submitted.edits[0].embeds[0].data.author.name, 'dave');
});

test('random author falls back to a user from the list when there are no likely repliers', async (t) => {
  const world = await newWorld(t);
  world.setRandom([0, 0.99]);
  const { submitted } = await openAndSubmit(world, 'random');
  assert.equal(submitted.replies[0].embeds[0].data.author.name, 'dave');
  assert.equal(submitted.edits[0].embeds[0].data.author.name, 'dave');
  assert.equal(world.randomCalls, 2);
});

test('works for a target authored by a bot', async (t) => {
  const world = await newWorld(t);
  const { submitted } = await openAndSubmit(world, 'bob', { content: CONTENT, author: 'helper-bot', bot: true });
  assert.equal(submitted.edits.length, 1);
  assert.equal(world.errors.length, 0);
});

test('works for a target authored by a non-approved user', async (t) => {
  const world = await newWorld(t);
  const { interaction, submitted } = await openAndSubmit(world, 'bob', { content: CONTENT, author: 'mallory' });
  assert.equal(interaction.modal.components[0].content, `**Original message from mallory:**\n${CONTENT}`);
  assert.equal(submitted.edits.length, 1);
});

test('fetches the guild by id when the target message has no guild and completes the flow', async (t) => {
  const world = await newWorld(t);
  const { submitted } = await openAndSubmit(world, 'bob', { content: CONTENT, guild: null });
  assert.deepEqual(world.discord.guildFetches, [GUILD_ID]);
  assert.equal(submitted.edits.length, 1);
  assert.equal(submitted.edits[0].embeds[0].data.author.icon_url, 'https://cdn.example/avatars/bob.png');
});

test('looks up the guild before checking the channel', async (t) => {
  const world = await newWorld(t);
  const interaction = await world.openReplyCommand({
    target: { content: CONTENT, guild: null, channel: world.discord.otherChannel },
  });
  assert.equal(world.discord.otherChannel.id, OTHER_CHANNEL_ID);
  assert.deepEqual(world.discord.guildFetches, [GUILD_ID]);
  assert.equal(interaction.replies[0].content, 'This command can only be used in the #pa-text channel.');
});

test('LLM failure after submit replaces the thinking reply with a failure notice and logs no handler error', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith(new Error('llm down'));
  const { submitted } = await openAndSubmit(world, 'bob');
  assert.equal(submitted.replies.length, 1);
  assert.equal(submitted.edits.length, 1);
  assert.equal(submitted.edits[0].content, GENERATION_FAILED_MESSAGE);
  assert.deepEqual(submitted.edits[0].embeds, []);
  assert.equal(world.errors.length, 0);
});

test('LLM failure after submit does not arm the rate limit', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith([new Error('llm down'), 'fine now']);
  await openAndSubmit(world, 'bob');
  world.setRandom(0);
  const message = await world.emitMessage({ content: CONTENT });
  assert.equal(message.replies.length, 1);
});

test('does not write the target message to the messages table', async (t) => {
  const world = await newWorld(t);
  await openAndSubmit(world, 'bob');
  assert.deepEqual(world.sqlite.all('SELECT id FROM messages'), []);
  assert.deepEqual(world.sqlite.all('SELECT id FROM filtered_messages'), []);
});

test('ignores a modal submission with a different custom id', async (t) => {
  const world = await newWorld(t);
  const other = await world.openReplyCommand({ target: { content: CONTENT } });
  const callsBefore = world.llm.calls.length;
  const wrong = await other.submit({ author: 'bob', customId: 'someOtherModal' });
  assert.equal(wrong.replies.length, 0);
  assert.equal(wrong.edits.length, 0);
  assert.equal(world.llm.calls.length, callsBefore);
});

test('a modal timeout sends nothing and does not throw', async (t) => {
  const world = await newWorld(t);
  const interaction = await world.openReplyCommand({ target: { content: CONTENT } });
  await interaction.timeout();
  assert.equal(interaction.replies.length, 0);
  assert.equal(world.discord.channel.sent.length, 0);
  assert.equal(world.llm.calls.length, 0);
  assert.equal(world.errors.length, 0);
});

test('a command reply starts the auto-reply rate limit', async (t) => {
  const world = await newWorld(t);
  await openAndSubmit(world, 'bob');
  await world.advance(5 * MINUTE - 1000);
  world.setRandom(0);
  const llmCalls = world.llm.calls.length;
  const message = await world.emitMessage({ content: CONTENT });
  assert.equal(message.replies.length, 0);
  assert.equal(world.llm.calls.length, llmCalls);
});

test('a command reply counts as bot activity so no revive follows', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ content: CONTENT });
  await openAndSubmit(world, 'bob');
  await world.advance(48 * HOUR);
  assert.equal(world.discord.channel.sent.length, 0);
});

test('works immediately after an auto reply, ignoring the rate limit and the probability roll', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const auto = await world.emitMessage({ content: CONTENT });
  assert.equal(auto.replies.length, 1);
  world.setRandom(0.99);
  const { submitted } = await openAndSubmit(world, 'bob');
  assert.equal(submitted.replies.length, 1);
  assert.equal(submitted.edits.length, 1);
});
