import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createReplyCommandHandler } from '../../../../src/bot/handlers/replyCommand.js';
import {
  createCommandLimiter, COMMAND_COOLDOWN_MESSAGE, COMMAND_BUSY_MESSAGE,
} from '../../../../src/bot/commandLimiter.js';
import { loadConfig } from '../../../../src/config.js';
import { createFakeDiscord } from '../../../support/fakes/discord.js';
import { GENERATION_FAILED_MESSAGE } from '../../../../src/discord/replyModal.js';
import { USERS } from '../../../support/fixtures.js';

const DEFER = { flags: MessageFlags.Ephemeral };

const setup = ({
  target = null, failCompose = false, resolveBot = () => null, armNoticeFailure = false, limiter = null,
  users = USERS, pickReplier = null,
} = {}) => {
  const events = [];
  const order = [];
  const time = { now: 1000000 };
  const logs = { info: [], error: [] };
  const discord = createFakeDiscord();
  const message = target ?? discord.makeMessage({ author: 'bob', content: 'a replyable message' });
  const config = loadConfig({});
  const commandLimiter = limiter ?? createCommandLimiter({ config, now: () => time.now });
  const deps = {
    client: {
      guilds: { fetch: async (id) => (events.push(['guildFetch', id]), order.push('guildFetch'), discord.state.guild) },
    },
    config,
    users,
    messageFilter: { filterAnyAuthor: (record) => (record.content.length < 5 ? null : record) },
    personaSelector: {
      pickReplier: pickReplier ?? (async () => (events.push('pickReplier'), order.push('pickReplier'), 'carol')),
    },
    responder: {
      respond: async (request) => {
        events.push(['respond', request.trigger, request.persona, request.target.content]);
        if (failCompose) {
          if (armNoticeFailure) request.via.interaction.failEdits(new Error('edit failed'));
          throw new Error('llm down');
        }
        const message = await request.via.interaction.editReply({ content: 'c', embeds: ['final'] });
        request.onDelivered?.();
        return { response: 'resp', messages: [message] };
      },
    },
    delivery: {
      deferOptions: () => DEFER,
      placeholder: async ({ persona }) => ({
        embeds: [{ author: persona, thinking: true }], allowedMentions: { parse: [] },
      }),
    },
    commandLimiter,
    replyPolicy: { noteReply: (arg) => events.push(['noteReply', arg]) },
    botMessageResolver: { resolve: (m) => resolveBot(m) },
    logger: { info: (m) => logs.info.push(m), error: (...a) => logs.error.push(a) },
  };
  const command = discord.makeReplyCommand({ target: message, user: 'dave' });
  const taken = command.awaitModalSubmit;
  command.awaitModalSubmit = async (options) => {
    const modal = await taken(options);
    const defer = modal.deferReply;
    modal.deferReply = async (...args) => (order.push('deferReply'), defer(...args));
    const edit = modal.editReply;
    modal.editReply = async (...args) => (order.push('editReply'), edit(...args));
    return modal;
  };
  return {
    handler: createReplyCommandHandler(deps), command, events, order, logs, discord, message, commandLimiter, time, config,
  };
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
  assert.deepEqual(command.replies, [{ content: 'The selected message is not replyable.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }]);
  assert.equal(command.modal, null);
  assert.deepEqual(events, []);
});

test('refuses a target in another channel without any network call', async () => {
  const discord0 = createFakeDiscord();
  const target = discord0.makeMessage({ content: 'replyable text', channel: discord0.state.otherChannel, guild: null });
  const { handler, command, events } = setup({ target });
  await (await run(handler, command)).done;
  assert.deepEqual(events, []);
  assert.deepEqual(command.replies, [{ content: "This command can only be used in the bot's channel.", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }]);
  assert.equal(command.modal, null);
});

test('shows the modal and waits with the configured timeout', async () => {
  const { handler, command } = setup();
  await run(handler, command);
  assert.equal(command.modal.custom_id, `replyModal:${command.id}`);
  assert.equal(command.modalOptions.time, 120000);
  assert.equal(typeof command.modalOptions.filter, 'function');
  await command.timeout();
});

test('submitting a chosen author defers, shows the placeholder, edits the reply, then updates state', async () => {
  const { handler, command, events, logs, order } = setup();
  await run(handler, command);
  const submitted = await command.submit({ author: 'bob' });
  assert.deepEqual(submitted.deferrals, [DEFER]);
  assert.deepEqual(submitted.replies, []);
  assert.deepEqual(submitted.edits, [
    { embeds: [{ author: 'bob', thinking: true }], allowedMentions: { parse: [] } },
    { content: 'c', embeds: ['final'] },
  ]);
  assert.deepEqual(order, ['deferReply', 'editReply', 'editReply']);
  assert.deepEqual(events, [['respond', 'command', 'bob', 'a replyable message'], ['noteReply', { resetMisses: false }]]);
  assert.equal(logs.info.length, 2);
  assert.match(logs.info[0], /^\[REQUEST REPLY from dave\] \[.*\] bob: a replyable message$/);
  assert.equal(logs.info[1], '    [REPLY] bob: resp');
});

test('random author uses the persona selector', async () => {
  const { handler, command, events } = setup();
  await run(handler, command);
  const submitted = await command.submit({ author: 'random' });
  assert.deepEqual(events.slice(0, 2), ['pickReplier', ['respond', 'command', 'carol', 'a replyable message']]);
  assert.equal(submitted.edits[0].embeds[0].author, 'carol');
});

test('replaces the thinking reply with a failure notice when generation fails, touching no state', async () => {
  const { handler, command, events, logs } = setup({ failCompose: true });
  await run(handler, command);
  const submitted = await command.submit({ author: 'bob' });
  assert.equal(submitted.deferrals.length, 1);
  assert.equal(submitted.edits.length, 2);
  assert.deepEqual(submitted.edits[1], { content: GENERATION_FAILED_MESSAGE, embeds: [], allowedMentions: { parse: [] } });
  assert.deepEqual(events, [['respond', 'command', 'bob', 'a replyable message']]);
  assert.equal(logs.error.length, 1);
});

test('only logs when the failure notice itself cannot be sent', async () => {
  const { handler, command, events, logs } = setup({ failCompose: true, armNoticeFailure: true });
  await run(handler, command);
  const submitted = await command.submit({ author: 'bob' });
  assert.equal(submitted.edits.length, 1);
  assert.deepEqual(events, [['respond', 'command', 'bob', 'a replyable message']]);
  assert.equal(logs.error.length, 2);
});

test('a failed acknowledgement is logged, sends nothing else and frees the limiter', async () => {
  const { handler, command, events, logs, commandLimiter } = setup();
  const taken = command.awaitModalSubmit;
  command.awaitModalSubmit = async (options) => {
    const modal = await taken(options);
    modal.failDefer(new Error('defer failed'));
    return modal;
  };
  await run(handler, command);
  const submitted = await command.submit({ author: 'bob' });
  assert.deepEqual([submitted.edits, submitted.replies, submitted.deferrals, events], [[], [], [], []]);
  assert.equal(logs.error.length, 1);
  assert.equal(commandLimiter.check('another-user').allowed, true);
  assert.equal(commandLimiter.begin('third-user').allowed, true);
  assert.equal(commandLimiter.begin('fourth-user').allowed, true);
  assert.equal(commandLimiter.begin('fifth-user').allowed, false);
});

test('a failed placeholder still gets the failure notice and no reply is generated', async () => {
  const { handler, command, events, logs } = setup();
  const taken = command.awaitModalSubmit;
  command.awaitModalSubmit = async (options) => {
    const modal = await taken(options);
    modal.failEdits(new Error('edit failed'));
    return modal;
  };
  await run(handler, command);
  const submitted = await command.submit({ author: 'bob' });
  assert.deepEqual(events, []);
  assert.equal(submitted.edits.length, 1);
  assert.equal(submitted.edits[0].content, GENERATION_FAILED_MESSAGE);
  assert.equal(logs.error.length, 1);
});

test('a failing persona choice is reported through the failure notice, after the acknowledgement', async () => {
  const { handler, command, logs, order } = setup({
    pickReplier: async () => { throw new Error('embedding down'); },
  });
  await run(handler, command);
  const submitted = await command.submit({ author: 'random' });
  assert.deepEqual(order, ['deferReply', 'editReply']);
  assert.equal(submitted.edits[0].content, GENERATION_FAILED_MESSAGE);
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
  assert.deepEqual(logs.error, []);
  assert.deepEqual(logs.info, ['reply modal dismissed or timed out']);
});

test('failures before the modal are logged, not thrown', async () => {
  const { handler, command, logs } = setup();
  command.showModal = async () => { throw new Error('modal refused'); };
  await (await run(handler, command)).done;
  assert.equal(logs.error.length, 1);
});

test('a bot message target is attributed to its persona, which is the modal default', async () => {
  const discord0 = createFakeDiscord();
  const botMessage = discord0.makeMessage({ author: 'deep-pa-text', bot: true, content: '' });
  const { handler, command, events } = setup({
    target: botMessage, resolveBot: () => ({ persona: 'carol', content: 'persona words' }),
  });
  await run(handler, command);
  const options = command.modal.components[1].component.options;
  assert.deepEqual(options.filter((o) => o.default).map((o) => o.value), ['carol']);
  assert.match(command.modal.components[0].content, /^\*\*Original message from carol:\*\*\npersona words$/);
  await command.submit({ author: 'bob' });
  assert.deepEqual(events[0], ['respond', 'command', 'bob', 'persona words']);
});

test('a human target has no default option', async () => {
  const { handler, command } = setup();
  await run(handler, command);
  const options = command.modal.components[1].component.options;
  assert.equal(options.some((o) => o.default), false);
  await command.timeout();
});

test('acknowledges before choosing the persona and before any guild lookup', async () => {
  const discord0 = createFakeDiscord();
  const target = discord0.makeMessage({ content: 'replyable text', guild: null });
  const { handler, command, order } = setup({ target });
  await run(handler, command);
  assert.deepEqual(order, []);
  await command.submit({ author: 'random' });
  assert.deepEqual(order.slice(0, 3), ['deferReply', 'guildFetch', 'pickReplier']);
});

test('refuses an invocation inside the user cooldown with an ephemeral message and no modal', async () => {
  const { handler, command, commandLimiter } = setup();
  commandLimiter.begin('user-dave');
  commandLimiter.end();
  await (await run(handler, command)).done;
  assert.deepEqual(command.replies, [{
    content: COMMAND_COOLDOWN_MESSAGE, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
  }]);
  assert.equal(command.modal, null);
});

test('refuses an invocation while the command is busy', async () => {
  const { handler, command, commandLimiter } = setup();
  commandLimiter.begin('u1');
  commandLimiter.begin('u2');
  await (await run(handler, command)).done;
  assert.equal(command.replies[0].content, COMMAND_BUSY_MESSAGE);
  assert.equal(command.modal, null);
});

test('refuses a submission that loses the claim race with an ephemeral reply and no deferral', async () => {
  const { handler, command, commandLimiter, events } = setup();
  await run(handler, command);
  commandLimiter.begin('user-dave');
  commandLimiter.end();
  const submitted = await command.submit({ author: 'bob' });
  assert.deepEqual(submitted.deferrals, []);
  assert.deepEqual(submitted.replies, [{
    content: COMMAND_COOLDOWN_MESSAGE, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
  }]);
  assert.deepEqual(events, []);
});

test('a submission refused as busy is told so and generates nothing', async () => {
  const { handler, command, commandLimiter, events } = setup();
  await run(handler, command);
  commandLimiter.begin('u1');
  commandLimiter.begin('u2');
  const submitted = await command.submit({ author: 'bob' });
  assert.equal(submitted.replies[0].content, COMMAND_BUSY_MESSAGE);
  assert.deepEqual(events, []);
});

test('the limiter is released after a successful reply and after a failed one', async () => {
  for (const failCompose of [false, true]) {
    const { handler, command, commandLimiter } = setup({ failCompose });
    await run(handler, command);
    await command.submit({ author: 'bob' });
    assert.equal(commandLimiter.begin('x').allowed, true);
    assert.equal(commandLimiter.begin('y').allowed, true);
    assert.equal(commandLimiter.begin('z').allowed, false, 'only the two probes are active');
  }
});

test('the modal preview is cut to the configured number of characters', async () => {
  const discord0 = createFakeDiscord();
  const target = discord0.makeMessage({ content: 'x'.repeat(5000) });
  const { handler, command, config } = setup({ target });
  await run(handler, command);
  const text = command.modal.components[0].content;
  assert.equal(text, `**Original message from alice:**\n${'x'.repeat(config.discord.modalPreviewChars)}…`);
  await command.timeout();
});
