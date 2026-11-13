import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviveTick } from '../../../../src/bot/handlers/reviveTick.js';
import { loadConfig } from '../../../../src/config.js';
import { createFakeDiscord } from '../../../support/fakes/discord.js';
import { BASE_TIME } from '../../../support/fixtures.js';

const HOUR = 3600000;

// By default the conversation policy never starts one, so the plain revive path is what runs.
const setup = ({
  env = {}, activity = { lastMessageTime: BASE_TIME - 4 * HOUR, lastWasBot: false }, failCompose = false,
  decision = { start: false, reason: 'roll' }, plan = null, runner = null,
} = {}) => {
  const events = [];
  const time = { now: BASE_TIME };
  const logs = { info: [], error: [] };
  const discord = createFakeDiscord();
  const client = {
    channels: { fetch: async (id) => (events.push(['fetch', id]), discord.state.channel) },
    guilds: { fetch: async (id) => (events.push(['guildFetch', id]), discord.state.guild) },
  };
  const deps = {
    client,
    config: loadConfig(env),
    activity: {
      get: () => activity,
      noteBot: () => {
        events.push('noteBot');
        return () => events.push('undo');
      },
    },
    personaSelector: { pickRandomUser: () => (events.push('pick'), 'dave') },
    responder: {
      respond: async (request) => {
        events.push(['respond', request.trigger, request.persona, request.target, request.guild === discord.state.guild, request.channel === discord.state.channel]);
        if (failCompose) throw new Error('llm down');
        if (request.via.type !== 'channel') throw new Error('unexpected via');
        const message = await request.via.channel.send({ content: 'c', embeds: [] });
        request.onDelivered?.();
        return { response: 'resp', messages: [message] };
      },
    },
    replyPolicy: { claim: () => (events.push('claim'), () => events.push('release')) },
    conversationPolicy: { decide: () => (events.push('decide'), decision) },
    conversationPlanner: {
      plan: async (arg) => {
        events.push(['plan', arg.channel === discord.state.channel]);
        if (plan instanceof Error) throw plan;
        return plan;
      },
    },
    conversationRunner: {
      run: async (arg) => {
        events.push(['run', arg.plan.id, arg.channel === discord.state.channel, arg.guild === discord.state.guild]);
        return runner ? runner(arg) : { delivered: arg.plan.turns.length };
      },
    },
    clock: { now: () => time.now },
    logger: { info: (m) => logs.info.push(m), error: (...a) => logs.error.push(a) },
  };
  return { tick: createReviveTick(deps), events, logs, discord, client, time };
};

test('does nothing when revive is not due', async () => {
  const { tick, events } = setup({ activity: { lastMessageTime: BASE_TIME - 3 * HOUR, lastWasBot: false } });
  await tick();
  assert.deepEqual(events, []);
});

test('does nothing when the bot spoke last', async () => {
  const { tick, events } = setup({ activity: { lastMessageTime: 0, lastWasBot: true } });
  await tick();
  assert.deepEqual(events, []);
});

test('revives: claims activity first, responds through the channel, claims again, logs', async () => {
  const { tick, events, logs, discord } = setup();
  await tick();
  assert.deepEqual(events, [
    'decide', 'noteBot', ['fetch', '704837777564500149'], 'pick', ['respond', 'revive', 'dave', null, true, true], 'noteBot',
  ]);
  assert.deepEqual(discord.state.channel.sent, [{ content: 'c', embeds: [] }]);
  assert.deepEqual(logs.info, ['[REVIVE] dave: resp']);
});

test('override revives regardless of activity', async () => {
  const { tick, discord } = setup({ env: { REVIVE_OVERRIDE: 'true' }, activity: { lastMessageTime: BASE_TIME, lastWasBot: true } });
  await tick();
  assert.equal(discord.state.channel.sent.length, 1);
});

test('fetches the guild through client.guilds when the channel has none', async () => {
  const { tick, events, discord, client } = setup();
  const channel = { ...discord.state.channel, guild: undefined };
  channel.send = async (payload) => channel.sent.push(payload);
  client.channels.fetch = async () => channel;
  await tick();
  assert.deepEqual(events.filter((e) => Array.isArray(e) && e[0] === 'guildFetch'), [['guildFetch', channel.guildId]]);
  assert.equal(channel.sent.length, 1);
});

test('generation failure undoes the claim, sends nothing and logs', async () => {
  const { tick, events, logs, discord } = setup({ failCompose: true });
  await tick();
  assert.equal(events.filter((e) => e === 'noteBot').length, 1);
  assert.equal(events.at(-1), 'undo');
  assert.deepEqual(discord.state.channel.sent, []);
  assert.equal(logs.error.length, 1);
});

test('a rejected send is logged, never thrown, the second claim is skipped and the first undone', async () => {
  const { tick, events, logs, discord } = setup();
  discord.state.channel.failSends(new Error('send failed'));
  await tick();
  assert.equal(events.filter((e) => e === 'noteBot').length, 1);
  assert.equal(events.at(-1), 'undo');
  assert.equal(logs.error.length, 1);
  assert.deepEqual(logs.info, []);
});

test('a channel fetch failure is logged and never throws', async () => {
  const { tick, client, logs } = setup();
  client.channels.fetch = async () => { throw new Error('unknown channel'); };
  await tick();
  assert.equal(logs.error.length, 1);
});

const attempts = (events) => events.filter((e) => Array.isArray(e) && e[0] === 'respond').length;
const COOLDOWN = 1800000;

test('a failed attempt blocks the next one for 1799999 ms and allows it at 1800000 ms', async () => {
  const { tick, events, time } = setup({ failCompose: true });
  await tick();
  time.now += COOLDOWN - 1;
  await tick();
  assert.equal(attempts(events), 1);
  time.now += 1;
  await tick();
  assert.equal(attempts(events), 2);
});

test('a failed delivery also starts the cooldown', async () => {
  const { tick, events, discord, time } = setup();
  discord.state.channel.failSends(new Error('send failed'));
  await tick();
  time.now += 10 * 60000;
  await tick();
  assert.equal(attempts(events), 1);
});

test('a successful revive starts no cooldown', async () => {
  const { tick, events, time } = setup();
  await tick();
  time.now += 1;
  await tick();
  assert.equal(attempts(events), 2);
});

test('the cooldown also holds back an override revive', async () => {
  const { tick, events, time } = setup({ env: { REVIVE_OVERRIDE: 'true' }, failCompose: true });
  await tick();
  time.now += 60000;
  await tick();
  assert.equal(attempts(events), 1);
});

test('each tick instance keeps its own cooldown', async () => {
  const failing = setup({ failCompose: true });
  await failing.tick();
  const fresh = setup();
  await fresh.tick();
  assert.equal(attempts(fresh.events), 1);
});

const PLAN = {
  id: 'c1', topic: 'Weekend plans', personas: ['alice', 'bob'], turns: ['alice', 'bob', 'alice'],
};
const START = { start: true, roll: 0.05 };

test('does not ask the conversation policy when no revive is due, or during the cooldown', async () => {
  const idle = setup({ activity: { lastMessageTime: BASE_TIME, lastWasBot: false } });
  await idle.tick();
  assert.deepEqual(idle.events, []);
  const cooling = setup({ failCompose: true });
  await cooling.tick();
  cooling.events.length = 0;
  await cooling.tick();
  assert.deepEqual(cooling.events, []);
});

test('a started conversation fetches the channel once, holds replies before planning and releases at the end', async () => {
  const { tick, events, logs } = setup({ decision: START, plan: PLAN });
  await tick();
  assert.deepEqual(events, [
    'decide', ['fetch', '704837777564500149'], 'claim', 'noteBot', ['plan', true], ['run', 'c1', true, true], 'release',
  ]);
  assert.deepEqual(logs.info, ['[CONVERSATION] Weekend plans (alice, bob): 3 of 3 turns delivered']);
  assert.deepEqual(logs.error, []);
});

test('the runner is told when the first turn goes out and the claim is then kept', async () => {
  const { tick, events } = setup({
    decision: START,
    plan: PLAN,
    runner: (arg) => {
      arg.onFirstDelivered();
      return { delivered: 1 };
    },
  });
  await tick();
  assert.equal(events.includes('undo'), false);
});

test('planning that fails is logged and a normal revive goes out in the same tick with the same channel and one claim', async () => {
  const { tick, events, logs, discord } = setup({ decision: START, plan: { failed: 'no-topics' } });
  await tick();
  assert.deepEqual(events, [
    'decide', ['fetch', '704837777564500149'], 'claim', 'noteBot', ['plan', true], 'pick',
    ['respond', 'revive', 'dave', null, true, true], 'noteBot', 'release',
  ]);
  assert.match(logs.info[0], /No conversation \(no-topics\); sending a normal revive/);
  assert.equal(logs.info[1], '[REVIVE] dave: resp');
  assert.equal(discord.state.channel.sent.length, 1);
});

test('a fallback revive that fails undoes the claim, arms the cooldown and releases the hold', async () => {
  const { tick, events, logs, discord } = setup({ decision: START, plan: { failed: 'topic-call' }, failCompose: true });
  await tick();
  assert.equal(events.at(-2), 'undo');
  assert.equal(events.at(-1), 'release');
  assert.deepEqual(discord.state.channel.sent, []);
  assert.equal(logs.error.length, 1);
});

test('a planner that throws is a failed revive: undo, release and the revive cooldown', async () => {
  const { tick, events, logs, time } = setup({ decision: START, plan: new Error('db locked') });
  await tick();
  assert.deepEqual(events.slice(-2), ['undo', 'release']);
  assert.equal(logs.error.length, 1);
  events.length = 0;
  time.now += 1800000 - 1;
  await tick();
  assert.deepEqual(events, []);
});

test('an opener that fails rejects the run: nothing was delivered so the claim is undone, no fallback revive', async () => {
  const { tick, events, logs, time } = setup({
    decision: START,
    plan: PLAN,
    runner: () => {
      throw Object.assign(new Error('llm down'), { stage: 'generation', persona: 'alice', trigger: 'conversation' });
    },
  });
  await tick();
  assert.deepEqual(events.slice(-2), ['undo', 'release']);
  assert.equal(events.some((e) => Array.isArray(e) && e[0] === 'respond'), false);
  assert.match(logs.error[0][0], /conversation turn as alice, stage generation/);
  time.now += 1800000;
  events.length = 0;
  await tick();
  assert.equal(events[0], 'decide');
});

test('once a turn was delivered a later failure keeps the activity claim', async () => {
  const { tick, events } = setup({
    decision: START,
    plan: PLAN,
    runner: (arg) => {
      arg.onFirstDelivered();
      throw new Error('boom');
    },
  });
  await tick();
  assert.equal(events.includes('undo'), false);
  assert.equal(events.at(-1), 'release');
});

test('a tick that finds a conversation still running returns at once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { tick, events } = setup({ decision: START, plan: PLAN, runner: () => gate.then(() => ({ delivered: 3 })) });
  const first = tick();
  await tick();
  assert.equal(events.filter((e) => e === 'decide').length, 1);
  release();
  await first;
  events.length = 0;
  await tick();
  assert.equal(events[0], 'decide', 'the flag is cleared afterwards');
});

test('the running flag is cleared after a failed tick too', async () => {
  const { tick, events, time } = setup({ failCompose: true });
  await tick();
  time.now += 1800000;
  events.length = 0;
  await tick();
  assert.equal(events[0], 'decide');
});

test('a channel fetch failure before planning claims nothing and holds nothing', async () => {
  const { tick, client, events, logs } = setup({ decision: START, plan: PLAN });
  client.channels.fetch = async () => { throw new Error('unknown channel'); };
  await tick();
  assert.deepEqual(events, ['decide']);
  assert.equal(logs.error.length, 1);
});
