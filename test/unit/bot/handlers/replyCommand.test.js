import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createReplyCommandHandler } from '../../../../src/bot/handlers/replyCommand.js';
import { loadConfig } from '../../../../src/config.js';
import { createFakeDiscord } from '../../../support/fakes/discord.js';
import { USERS } from '../../../support/fixtures.js';

const setup = ({ target = null, failCompose = false } = {}) => {
  const events = [];
  const logs = { info: [], error: [] };
  const discord = createFakeDiscord();
  const message = target ?? discord.makeMessage({ author: 'bob', content: 'a replyable message' });
  const deps = {
    client: { guilds: { fetch: async (id) => (events.push(['guildFetch', id]), discord.state.guild) } },
    config: loadConfig({}),
    users: USERS,
    messageFilter: { filterAnyAuthor: (record) => (record.content.length < 5 ? null : record) },
    personaSelector: { pickReplier: async () => (events.push('pickReplier'), 'carol') },
    composer: {
      composeReply: async ({ persona }) => {
        events.push(['compose', persona]);
        if (failCompose) throw new Error('llm down');
        return { response: 'resp', payload: { content: 'c', embeds: ['final'] } };
      },
    },
    authorEmbeds: { make: async (author, guild, opts) => ({ author, thinking: opts.thinking }) },
    replyPolicy: { noteReply: (arg) => events.push(['noteReply', arg]) },
    activity: { noteBot: () => events.push('noteBot') },
    logger: { info: (m) => logs.info.push(m), error: (...a) => logs.error.push(a) },
  };
  const command = discord.makeReplyCommand({ target: message, user: 'dave' });
  return { handler: createReplyCommandHandler(deps), command, events, logs, discord, message };
};

// Starts the handler and yields until it parks on the modal (or finishes).
const run = async (handler, interaction) => {
  const done = handler(interaction);
  await new Promise((resolve) => setImmediate(resolve));
  return { done };
};

test('ignores other interactions', async () => {
  const { handler, discord } = setup();
  const plain = discord.makeInteraction();
  await handler(plain);
  const other = discord.makeInteraction({ isMessageContextMenuCommand: () => true, commandName: 'other' });
  await handler(other);
  assert.deepEqual([...plain.replies, ...other.replies], []);
});

test('refuses an unreplyable target with an ephemeral message', async () => {
  const discord0 = createFakeDiscord();
  const { handler, command, events } = setup({ target: discord0.makeMessage({ content: 'hi' }) });
  await (await run(handler, command)).done;
  assert.deepEqual(command.replies, [{ content: 'The selected message is not replyable.', flags: MessageFlags.Ephemeral }]);
  assert.equal(command.modal, null);
  assert.deepEqual(events, []);
});

test('refuses a target in another channel after fetching the guild', async () => {
  const discord0 = createFakeDiscord();
  const target = discord0.makeMessage({ content: 'replyable text', channel: discord0.state.otherChannel, guild: null });
  const { handler, command, events } = setup({ target });
  await (await run(handler, command)).done;
  assert.deepEqual(events, [['guildFetch', target.guildId]]);
  assert.deepEqual(command.replies, [{ content: 'This command can only be used in the #pa-text channel.', flags: MessageFlags.Ephemeral }]);
  assert.equal(command.modal, null);
});

test('shows the modal and waits with the configured timeout', async () => {
  const { handler, command } = setup();
  await run(handler, command);
  assert.equal(command.modal.custom_id, 'replyModal');
  assert.deepEqual(command.modalOptions, { time: 120000 });
  await command.timeout();
});

test('submitting a chosen author thinks, edits the reply, then updates state', async () => {
  const { handler, command, events, logs } = setup();
  await run(handler, command);
  const submitted = await command.submit({ author: 'bob' });
  assert.deepEqual(submitted.replies, [{ embeds: [{ author: 'bob', thinking: true }] }]);
  assert.deepEqual(submitted.edits, [{ content: 'c', embeds: ['final'] }]);
  assert.deepEqual(events, [['compose', 'bob'], ['noteReply', { resetMisses: false }], 'noteBot']);
  assert.equal(logs.info.length, 2);
  assert.match(logs.info[0], /^\[REQUEST REPLY from dave\] \[.*\] bob: a replyable message$/);
  assert.equal(logs.info[1], '    [REPLY] bob: resp');
});

test('random author uses the persona selector', async () => {
  const { handler, command, events } = setup();
  await run(handler, command);
  const submitted = await command.submit({ author: 'random' });
  assert.deepEqual(events.slice(0, 2), ['pickReplier', ['compose', 'carol']]);
  assert.equal(submitted.replies[0].embeds[0].author, 'carol');
});

test('touches no state when generation fails after the thinking reply', async () => {
  const { handler, command, events, logs } = setup({ failCompose: true });
  await run(handler, command);
  const submitted = await command.submit({ author: 'bob' });
  assert.equal(submitted.replies.length, 1);
  assert.deepEqual(submitted.edits, []);
  assert.deepEqual(events, [['compose', 'bob']]);
  assert.equal(logs.error.length, 1);
});

test('touches no state when editReply fails', async () => {
  const { handler, command, events, logs } = setup();
  const taken = command.awaitModalSubmit;
  command.awaitModalSubmit = async (options) => {
    const modal = await taken(options);
    modal.failEdits(new Error('edit failed'));
    return modal;
  };
  await run(handler, command);
  await command.submit({ author: 'bob' });
  assert.deepEqual(events, [['compose', 'bob']]);
  assert.equal(logs.error.length, 1);
});

test('ignores a modal with a different custom id', async () => {
  const { handler, command, events } = setup();
  await run(handler, command);
  const submitted = await command.submit({ author: 'bob', customId: 'other' });
  assert.deepEqual([submitted.replies, submitted.edits, events], [[], [], []]);
});

test('a modal timeout is logged and ends the flow without touching state', async () => {
  const { handler, command, events, logs } = setup();
  await run(handler, command);
  await command.timeout();
  assert.deepEqual(events, []);
  assert.equal(logs.error.length, 1);
  assert.match(String(logs.error[0][0]), /modal submission/);
});

test('failures before the modal are logged, not thrown', async () => {
  const { handler, command, logs } = setup();
  command.showModal = async () => { throw new Error('modal refused'); };
  await (await run(handler, command)).done;
  assert.equal(logs.error.length, 1);
});
