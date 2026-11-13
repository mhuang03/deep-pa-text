import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME, USERS } from '../support/fixtures.js';
import { REPLY_LINK_PREFIX } from '../../src/discord/webhookDelivery.js';
import { FAKE_DIMENSIONS } from '../support/fakes/chroma.js';
import { SYSTEM_PROMPT, CONVERSATION_OPENER_SYSTEM_PROMPT } from '../../src/llm/prompts.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const HELLO = 'hello there friends';
const REVIVE_DUE = 3 * HOUR + 10 * MINUTE;
const TICK_TIME = BASE_TIME + REVIVE_DUE;
const MIN_DELAY = 5000;
const MAX_DELAY = 30000;

const TOPIC_ANSWER = (fields) => JSON.stringify({ choice: 1, topic: 'Camping soon', premise: 'Someone floats a trip.', ...fields });
const isTopicCall = (request) => request.messages[0].content.startsWith('You are planning a short group chat');

// A scripted array repeats its last value, so a script is padded with zeros: every roll past it is 0.
const pad = (rolls) => [...rolls, ...Array(60).fill(0)];

// The conversation roll, two candidate draws, the persona count (0.25 is three), three persona draws, then the
// message count (0.25 is four); everything after that is 0.
const SCRIPT = pad([0.05, 0, 0, 0.25, 0, 0, 0, 0.25]);
const FIVE_TURNS = pad([0.05, 0, 0, 0.25, 0, 0, 0, 0.5]);

const THEMES = [
  {
    label: 'Camping trips', summary: 'People plan camping trips.',
    authors: ['alice', 'bob', 'carol'],
    lines: ['we should go camping near the lake this weekend', 'bring the big tent for the camping trip', 'the lake campsite was great last year'],
  },
  {
    label: 'Cooking dinner', summary: 'People swap recipes.',
    authors: ['bob', 'carol', 'dave'],
    lines: ['i made a great pasta dinner with fresh basil', 'try roasting the vegetables for the dinner', 'the sauce needs more garlic for dinner'],
  },
];

// Seeds the topic bank through the container, as `npm run topics` would have left it.
const seedBank = async (world, themes = THEMES) => {
  const { topicStore } = world.container;
  let index = 0;
  for (const theme of themes) {
    const rows = theme.lines.map((content, i) => ({
      id: `seed-${index}-${i}`, author: theme.authors[i % theme.authors.length], content, timestamp: BASE_TIME - (index + 2) * DAY + i,
    }));
    await world.seed(rows);
    topicStore.insertTopic({
      buildId: 'tb1', label: theme.label, summary: theme.summary, size: 30, authorCount: theme.authors.length, cohesion: 0.9,
      medianTimestamp: BASE_TIME - DAY,
      authors: theme.authors.map((author) => ({ author, share: 1 / theme.authors.length, newestTimestamp: BASE_TIME - DAY })),
      messages: rows.map((row) => row.id),
    });
    index += 1;
  }
  topicStore.completeBuild({ buildId: 'tb1', completedAt: BASE_TIME, stats: {} });
};

// `line(n, request)` is the text of the n-th generated turn (1-based); an Error fails that generation.
const script = ({ topic = TOPIC_ANSWER(), line = (n) => `line ${n}`, onTopic = null } = {}) => {
  let turns = 0;
  return (request) => {
    if (isTopicCall(request)) {
      onTopic?.();
      return typeof topic === 'function' ? topic() : topic;
    }
    turns += 1;
    return line(turns, request);
  };
};

const newWorld = async (t, { bank = THEMES, respond = script(), ...options } = {}) => {
  const world = await createWorld({ ...options, env: { CONVERSATIONS: 'true', ...options.env } });
  t.after(() => world.close());
  if (bank) await seedBank(world, bank);
  world.llm.respondWith(respond);
  return world;
};

// Arms the revive check with a human message, then scripts the rolls of the due tick.
const arm = async (world, rolls = SCRIPT) => {
  await world.ready();
  await world.emitMessage({ content: HELLO });
  world.setRandom(pad(rolls));
};

const startConversation = async (world, rolls) => {
  await arm(world, rolls);
  await world.advance(REVIVE_DUE);
};

const botRows = (world) => world.sqlite.all('SELECT * FROM bot_messages ORDER BY rowid');
const conversationRows = (world) => botRows(world).filter((row) => row.trigger === 'conversation');
const sentBy = (world) => world.discord.channel.sent.map((payload) => payload.embeds.at(-1).data.author.name);
const sentTexts = (world) => world.discord.channel.sent.map((payload) => payload.content);
const turnDelays = (world) => world.sleeps.filter((ms) => ms >= MIN_DELAY && ms <= MAX_DELAY);
const infoLogs = (world) => world.logs.log.map((args) => args.join(' '));
const errorLogs = (world) => world.logs.error.map((args) => args.join(' '));
const userPrompt = (call) => call.messages[1].content;

const insertConversationTurn = (world, ageMs) => world.container.botMessageStore.insert({
  id: 'old-turn', persona: 'bob', content: 'earlier turn', timestamp: TICK_TIME - ageMs, trigger: 'conversation',
  conversationId: 'c-old', turnIndex: 0,
});

test('a conversation of four turns: planned personas speak in order, each row references the previous turn', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  assert.deepEqual(sentTexts(world), ['line 1', 'line 2', 'line 3', 'line 4']);
  assert.deepEqual(sentBy(world), ['alice', 'bob', 'alice', 'carol']);
  const rows = conversationRows(world);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.persona), ['alice', 'bob', 'alice', 'carol']);
  assert.deepEqual(rows.map((row) => row.trigger), Array(4).fill('conversation'));
  assert.deepEqual(rows.map((row) => row.turn_index), [0, 1, 2, 3]);
  assert.equal(new Set(rows.map((row) => row.conversation_id)).size, 1);
  assert.match(rows[0].conversation_id, /^c\d{14}$/);
  assert.deepEqual(rows.map((row) => row.reference), [null, rows[0].id, rows[1].id, rows[2].id]);
  assert.deepEqual(world.discord.channel.sentMessages.map((m) => m.id), rows.map((row) => row.id));
});

test('the plan is stored and the three delays are within the bounds, none before the opener', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  const [row] = world.sqlite.all('SELECT * FROM conversations');
  assert.equal(row.topic, 'Camping soon');
  assert.equal(row.premise, 'Someone floats a trip.');
  assert.equal(row.topic_id, world.container.topicStore.currentTopics()[0].id);
  assert.deepEqual(JSON.parse(row.personas), ['alice', 'bob', 'carol']);
  assert.deepEqual(JSON.parse(row.turns), ['alice', 'bob', 'alice', 'carol']);
  assert.equal(row.id, conversationRows(world)[0].conversation_id);
  assert.deepEqual(turnDelays(world), [MIN_DELAY, MIN_DELAY, MIN_DELAY]);
});

test('delays are drawn from the rolls: 0 waits 5000 ms, 0.5 waits 17500 ms and just under 1 waits 30000 ms', async (t) => {
  const world = await newWorld(t);
  // After the 8 rolls above: one extra-turn pick, four arrangement picks, then the three delays.
  await startConversation(world, [0.05, 0, 0, 0.25, 0, 0, 0, 0.25, 0, 0, 0, 0, 0, 0, 0.5, 0.99999]);
  assert.deepEqual(turnDelays(world), [MIN_DELAY, 17500, MAX_DELAY]);
});

test('the opener is generated with the opener system prompt and the topic; later turns with the ordinary prompt', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  const [topicCall, opener, second, third] = world.llm.calls;
  assert.equal(world.llm.calls.length, 5);
  assert.match(userPrompt(topicCall), /Candidate topics:\n1\. Camping trips: People plan camping trips\./);
  assert.equal(opener.messages[0].content, CONVERSATION_OPENER_SYSTEM_PROMPT);
  assert.match(userPrompt(opener), /It is about: Camping soon\. Someone floats a trip\. Only these people take part; do not address anyone else\. You are starting it\./);
  assert.ok(!userPrompt(opener).includes('just received this message'));
  assert.equal(second.messages[0].content, SYSTEM_PROMPT);
  assert.match(userPrompt(second), /The user has just received this message from "alice": "line 1"\./);
  assert.match(userPrompt(third), /It is about: Camping soon/);
});

test('the request for turn 3 carries turns 1 and 2 and names the topic', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  const prompt = userPrompt(world.llm.calls[3]);
  assert.match(prompt, /between alice, bob, carol\. It is about: Camping soon\./);
  assert.match(prompt, /\[\d\d:\d\d\] alice: line 1\n/);
  assert.match(prompt, /received this message from "bob": "line 2"\./);
  assert.ok(!prompt.includes('line 3'));
  assert.match(prompt, /2 more messages follow yours\.|1 more messages follow yours\./);
});

test('the last turn is told that nobody replies', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  assert.match(userPrompt(world.llm.calls.at(-1)), /Nobody replies after this message/);
  assert.ok(!userPrompt(world.llm.calls[2]).includes('Nobody replies after this message'));
});

test('retrieval for the speaker uses only that speaker\'s own history', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  assert.match(userPrompt(world.llm.calls[1]), /username "alice"/);
  assert.match(userPrompt(world.llm.calls[2]), /username "bob"/);
  assert.match(userPrompt(world.llm.calls[4]), /username "carol"/);
});

test('with CONVERSATIONS=false the revive path makes exactly the rolls it made before and sends a revive', async (t) => {
  const world = await newWorld(t, { env: { CONVERSATIONS: 'false' } });
  await world.ready();
  await world.emitMessage({ content: HELLO });
  world.setRandom(0.3);
  const before = world.randomCalls;
  await world.advance(REVIVE_DUE);
  assert.equal(world.randomCalls - before, 1, 'only the persona roll');
  assert.deepEqual(botRows(world).map((row) => row.trigger), ['revive']);
  assert.equal(world.llm.calls.length, 1);
  assert.deepEqual(sentBy(world), ['bob']);
});

test('a conversation 23 hours ago is too soon: no roll is consumed and a normal revive is sent', async (t) => {
  const world = await newWorld(t);
  insertConversationTurn(world, 23 * HOUR);
  await world.ready();
  await world.emitMessage({ content: HELLO });
  world.setRandom(0.3);
  const before = world.randomCalls;
  await world.advance(REVIVE_DUE);
  assert.equal(world.randomCalls - before, 1);
  assert.deepEqual(botRows(world).map((row) => row.trigger), ['conversation', 'revive']);
  assert.equal(world.sqlite.all('SELECT * FROM conversations').length, 0);
});

test('25 hours ago with a roll of 0.05 starts a conversation; with a roll of 0.5 a normal revive goes out', async (t) => {
  const started = await newWorld(t);
  insertConversationTurn(started, 25 * HOUR);
  await startConversation(started);
  assert.equal(conversationRows(started).length, 5);
  assert.equal(started.sqlite.all('SELECT * FROM conversations').length, 1);
  await started.close();
  const skipped = await newWorld(t);
  insertConversationTurn(skipped, 25 * HOUR);
  await arm(skipped, [0.5, 0.3]);
  await skipped.advance(REVIVE_DUE);
  assert.deepEqual(botRows(skipped).map((row) => row.trigger), ['conversation', 'revive']);
  assert.equal(skipped.sqlite.all('SELECT * FROM conversations').length, 0);
});

test('an empty bank and a corpus with no neighbourhood: no-topics is logged and a normal revive goes out in the same tick', async (t) => {
  const world = await newWorld(t, { bank: null });
  await startConversation(world, [0.05, 0.3]);
  assert.ok(infoLogs(world).some((line) => line.includes('No conversation (no-topics); sending a normal revive instead.')));
  assert.deepEqual(botRows(world).map((row) => row.trigger), ['revive']);
  assert.equal(sentBy(world).length, 1);
  assert.equal(world.llm.calls.length, 1, 'no topic call');
  assert.equal(world.sqlite.all('SELECT * FROM conversations').length, 0);
});

test('the topic answer with prose around the JSON is parsed', async (t) => {
  const world = await newWorld(t, { respond: script({ topic: `Sure, here you go:\n${TOPIC_ANSWER()}\nHope that helps!` }) });
  await startConversation(world);
  assert.equal(conversationRows(world).length, 4);
});

test('an invalid topic answer twice is topic-call: a normal revive goes out and the persona roll follows the candidate rolls', async (t) => {
  const world = await newWorld(t, { respond: script({ topic: 'I cannot decide' }) });
  await startConversation(world, [0.05, 0, 0, 0.3]);
  assert.equal(world.llm.calls.filter(isTopicCall).length, 2);
  assert.ok(infoLogs(world).some((line) => line.includes('No conversation (topic-call)')));
  assert.deepEqual(botRows(world).map((row) => [row.trigger, row.persona]), [['revive', 'bob']]);
  assert.equal(world.sqlite.all('SELECT * FROM conversations').length, 0);
});

test('a choice out of range is invalid, and a valid retry is used', async (t) => {
  const answers = [TOPIC_ANSWER({ choice: 7 }), TOPIC_ANSWER()];
  const world = await newWorld(t, { respond: script({ topic: () => answers.shift() }) });
  await startConversation(world);
  assert.equal(world.llm.calls.filter(isTopicCall).length, 2);
  assert.equal(conversationRows(world).length, 4);
});

test('the topic call throwing is topic-call and a normal revive goes out', async (t) => {
  const world = await newWorld(t, { respond: script({ topic: () => new Error('llm down') }) });
  await startConversation(world, [0.05, 0, 0, 0.3]);
  assert.equal(world.llm.calls.filter(isTopicCall).length, 1, 'a throw is not retried');
  assert.deepEqual(botRows(world).map((row) => row.trigger), ['revive']);
});

test('a topic with two authors is topped up from the history when more personas are wanted', async (t) => {
  const bank = [{
    label: 'Camping trips', summary: 'People plan camping trips.', authors: ['alice', 'bob'],
    lines: ['we should go camping near the lake this weekend', 'bring the big tent for the camping trip'],
  }];
  const world = await newWorld(t, { bank });
  await world.seed([{ id: 'extra', author: 'carol', content: 'the lake campsite was great last year', timestamp: BASE_TIME - 9 * DAY }]);
  await startConversation(world, [0.05, 0, 0.25, 0, 0, 0, 0.25]);
  const personas = JSON.parse(world.sqlite.get('SELECT personas FROM conversations').personas);
  assert.deepEqual(personas, ['alice', 'bob', 'carol']);
  assert.ok(sentBy(world).includes('carol'));
});

test('nobody else found in the history means too-few-personas and a normal revive', async (t) => {
  const bank = [{
    label: 'Camping trips', summary: 'People plan camping trips.', authors: ['alice', 'bob'],
    lines: ['we should go camping near the lake this weekend', 'bring the big tent for the camping trip'],
  }];
  const world = await newWorld(t, { bank, config: { conversation: { minPersonas: 3, maxPersonas: 3 } } });
  await startConversation(world, [0.05, 0, 0, 0, 0, 0.3]);
  assert.ok(infoLogs(world).some((line) => line.includes('No conversation (too-few-personas)')));
  assert.deepEqual(botRows(world).map((row) => [row.trigger, row.persona]), [['revive', 'bob']]);
});

test('with two users in the directory a conversation has exactly two personas, strictly alternating', async (t) => {
  const users = USERS.slice(0, 2);
  const bank = [{ ...THEMES[0], authors: ['alice', 'bob'] }];
  const world = await newWorld(t, { users, bank });
  await startConversation(world, [0.05, 0, 0.99, 0, 0, 0.5]);
  const personas = JSON.parse(world.sqlite.get('SELECT personas FROM conversations').personas);
  assert.equal(personas.length, 2);
  const by = sentBy(world);
  assert.equal(by.length, 5);
  by.forEach((name, i) => assert.equal(name, by[i % 2]));
  assert.notEqual(by[0], by[1]);
});

test('five personas and six messages: everyone speaks, one persona twice, never consecutively', async (t) => {
  const users = [...USERS, { username: 'erin', name: 'Erin Example' }];
  const bank = [{ ...THEMES[0], authors: ['alice', 'bob', 'carol', 'dave', 'erin'] }];
  const world = await newWorld(t, { users, bank });
  await startConversation(world, [0.05, 0, 0.99, 0, 0, 0, 0, 0, 0.99]);
  const by = sentBy(world);
  assert.equal(by.length, 6);
  assert.deepEqual([...new Set(by)].sort(), ['alice', 'bob', 'carol', 'dave', 'erin']);
  by.forEach((name, i) => assert.notEqual(name, by[i - 1]));
  const counts = Object.values(by.reduce((acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }), {})).sort();
  assert.deepEqual(counts, [1, 1, 1, 1, 2]);
});

test('a turn that is a two-part burst sends two messages by the same persona and counts as one turn', async (t) => {
  const world = await newWorld(t, { respond: script({ line: (n) => (n === 2 ? 'part a\n<split>\npart b' : `line ${n}`) }) });
  await startConversation(world);
  assert.deepEqual(sentTexts(world), ['line 1', 'part a', 'part b', 'line 3', 'line 4']);
  assert.deepEqual(sentBy(world), ['alice', 'bob', 'bob', 'alice', 'carol']);
  const rows = conversationRows(world);
  assert.deepEqual(rows.map((row) => row.turn_index), [0, 1, 1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.reference), [null, rows[0].id, rows[0].id, rows[1].id, rows[3].id]);
  assert.equal(world.llm.calls.length, 5, 'still four turns');
  assert.match(userPrompt(world.llm.calls[3]), /received this message from "bob": "part a\npart b"\./);
});

test('generation that takes longer than the delay is sent as soon as it is ready, with no extra wait', async (t) => {
  let release;
  const respond = script({
    line: (n) => {
      if (n === 1) release = world.llm.hold();
      return `line ${n}`;
    },
  });
  const world = await newWorld(t, { respond });
  await startConversation(world);
  assert.equal(world.discord.channel.sent.length, 1, 'turn 2 is being generated');
  assert.deepEqual(turnDelays(world), []);
  await world.advance(MAX_DELAY + 5000);
  release();
  await world.settle();
  assert.equal(world.discord.channel.sent.length, 4);
  assert.deepEqual(turnDelays(world), [MIN_DELAY, MIN_DELAY], 'turn 2 waited for nothing; turns 3 and 4 slept their delay');
});

test('a human posting between turns is stored, gets no reply, and does not change the remaining turns', async (t) => {
  const world = await newWorld(t);
  let waits = 0;
  world.sleepHook = async (ms) => {
    if (ms < MIN_DELAY || ms > MAX_DELAY) return;
    waits += 1;
    if (waits !== 2) return;
    world.setRandom(0);
    const human = await world.emitMessage({ author: 'dave', content: 'interrupting the whole chat here' });
    assert.equal(human.replies.length, 0);
  };
  await startConversation(world);
  assert.equal(world.sqlite.get("SELECT COUNT(*) AS n FROM messages WHERE content = 'interrupting the whole chat here'").n, 1);
  assert.deepEqual(sentTexts(world), ['line 1', 'line 2', 'line 3', 'line 4']);
  assert.deepEqual(sentBy(world), ['alice', 'bob', 'alice', 'carol']);
  world.llm.calls.slice(1).forEach((call) => assert.ok(!userPrompt(call).includes('interrupting')));
  assert.equal(botRows(world).filter((row) => row.trigger === 'auto').length, 0);
});

test('while the opener is being generated a replyable human message gets no auto reply and starts no LLM call', async (t) => {
  let release;
  const world = await newWorld(t, { respond: script({ onTopic: () => { release = world.llm.hold(); } }) });
  await startConversation(world);
  const calls = world.llm.calls.length;
  assert.equal(calls, 2, 'the topic call and the held opener');
  world.setRandom(0);
  const bystander = await world.emitMessage({ author: 'dave', content: HELLO });
  assert.equal(bystander.replies.length, 0);
  assert.equal(world.llm.calls.length, calls);
  release();
  await world.settle();
  assert.equal(conversationRows(world).length, 4);
});

test('the hold is released when the conversation ends: later messages get auto replies again', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  world.setRandom(0);
  const early = await world.emitMessage({ author: 'dave', content: HELLO });
  assert.equal(early.replies.length, 0, 'within 5 minutes of the last turn');
  await world.advance(5 * MINUTE + 1);
  world.setRandom(0);
  const later = await world.emitMessage({ author: 'dave', content: HELLO });
  assert.equal(later.replies.length, 1);
});

test('after a conversation no revive is due until a human speaks', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  const sent = world.discord.channel.sent.length;
  world.setRandom(0.05);
  await world.advance(2 * DAY);
  assert.equal(world.discord.channel.sent.length, sent);
  assert.equal(world.sqlite.all('SELECT * FROM conversations').length, 1);
});

test('the revive check firing again while a conversation is running is ignored', async (t) => {
  let release;
  const world = await newWorld(t, { respond: script({ onTopic: () => { release = world.llm.hold(); } }) });
  await startConversation(world);
  const [calls, rolls] = [world.llm.calls.length, world.randomCalls];
  await world.advance(30 * MINUTE);
  assert.equal(world.llm.calls.length, calls);
  assert.equal(world.randomCalls, rolls, 'the ticks consumed no roll');
  release();
  await world.settle();
  assert.equal(conversationRows(world).length, 4);
});

test('turn 3 of 5 failing keeps turns 1 and 2, logs an error, releases the hold and counts the interval from turn 2', async (t) => {
  const world = await newWorld(t, { respond: script({ line: (n) => (n === 3 ? new Error('llm down') : `line ${n}`) }) });
  await startConversation(world, FIVE_TURNS);
  assert.deepEqual(sentTexts(world), ['line 1', 'line 2']);
  assert.equal(conversationRows(world).length, 2);
  assert.ok(errorLogs(world).some((line) => /Conversation c\d+ ended after 2 of 5 turns \(conversation turn as alice, stage generation\)/.test(line)));
  assert.ok(!errorLogs(world).some((line) => line.includes('Error in revive interval')), 'not a failed revive');
  await world.advance(5 * MINUTE + 1);
  world.setRandom(0);
  const later = await world.emitMessage({ author: 'dave', content: HELLO });
  assert.equal(later.replies.length, 1, 'the hold was released');
  const { conversationPolicy } = world.container;
  world.setRandom(0.05);
  await world.advance(22 * HOUR);
  assert.deepEqual(conversationPolicy.decide(), { start: false, reason: 'too-soon' });
  await world.advance(2 * HOUR);
  assert.equal(conversationPolicy.decide().start, true);
});

test('the opener failing sends nothing, applies the revive failure cooldown and makes no fallback revive', async (t) => {
  const world = await newWorld(t, { respond: script({ line: (n) => (n === 1 ? new Error('llm down') : `line ${n}`) }) });
  await startConversation(world);
  assert.deepEqual(world.discord.channel.sent, []);
  assert.deepEqual(botRows(world), []);
  assert.ok(errorLogs(world).some((line) => line.includes('Error in revive interval (conversation turn as alice, stage generation)')));
  assert.equal(world.llm.calls.length, 2, 'the topic call and the opener, no revive');
  world.setRandom(SCRIPT);
  await world.advance(20 * MINUTE);
  assert.equal(world.llm.calls.length, 2, 'cooling down for 30 minutes');
  await world.advance(15 * MINUTE);
  assert.ok(world.llm.calls.length > 2, 'the activity was given back, so the next attempt is allowed');
});

test('a shutdown during the wait before turn 3 sends no further turns, quietly', async (t) => {
  const world = await newWorld(t);
  let waits = 0;
  let shutdown = null;
  world.sleepHook = async (ms) => {
    if (ms < MIN_DELAY || ms > MAX_DELAY) return;
    waits += 1;
    if (waits === 2) shutdown = world.container.lifecycle.shutdown({ code: 0 });
  };
  await startConversation(world);
  await shutdown;
  assert.deepEqual(sentTexts(world), ['line 1', 'line 2']);
  assert.ok(!errorLogs(world).some((line) => /Conversation c\d+ ended/.test(line)));
  assert.deepEqual(world.exits, [0]);
  await world.advance(2 * DAY);
  assert.equal(world.discord.channel.sent.length, 2);
});

test('after a restart the conversation is not resumed; its last turn restores the rate limit and the bot as last speaker', async (t) => {
  const world = await newWorld(t, {
    bank: null,
    config: { embedding: { dimensions: FAKE_DIMENSIONS } },
    preload: async (container) => {
      await container.ingest.recordMessage({ id: 'h1', author: 'alice', content: HELLO, timestamp: BASE_TIME - 2 * MINUTE, reference: null });
      container.botMessageStore.insert({
        id: 'k1', persona: 'bob', content: 'last turn', timestamp: BASE_TIME - MINUTE, trigger: 'conversation',
        conversationId: 'c-prev', turnIndex: 3, reference: 'k0',
      });
    },
  });
  await world.ready();
  world.setRandom(0);
  const early = await world.emitMessage({ author: 'dave', content: HELLO });
  assert.equal(early.replies.length, 0, 'rate limited by the conversation turn');
  await world.advance(2 * DAY);
  // The human message made a revive due; it is a plain revive, and no further turn of the old conversation appears.
  assert.deepEqual(botRows(world).map((row) => row.trigger), ['conversation', 'revive']);
  assert.equal(world.llm.calls.length, 1, 'nothing is resumed');
});

test('after a restart with a conversation turn newer than the last human message, no revive is due', async (t) => {
  const world = await newWorld(t, {
    bank: null,
    config: { embedding: { dimensions: FAKE_DIMENSIONS } },
    preload: async (container) => {
      await container.ingest.recordMessage({ id: 'h1', author: 'alice', content: HELLO, timestamp: BASE_TIME - 5 * HOUR, reference: null });
      container.botMessageStore.insert({
        id: 'k1', persona: 'bob', content: 'last turn', timestamp: BASE_TIME - HOUR, trigger: 'conversation',
        conversationId: 'c-prev', turnIndex: 3,
      });
    },
  });
  await world.ready();
  await world.advance(3 * HOUR);
  assert.equal(world.discord.channel.sent.length, 0);
});

test('a human reply to turn 2 gets a chain reply as turn 2\'s persona that sees turns 1 and 2 and is guaranteed', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  const [, turn2] = conversationRows(world);
  world.llm.respondWith('chain says hi');
  world.setRandom(0.99);
  const reply = await world.emitMessage({ author: 'dave', content: 'why though', reference: turn2.id });
  assert.equal(reply.replies.length, 1);
  const row = botRows(world).at(-1);
  assert.deepEqual([row.trigger, row.persona, row.reference], ['chain', 'bob', reply.id]);
  const messages = world.llm.calls.at(-1).messages;
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(messages[1].content, /alice: line 1$/);
  assert.equal(messages[2].content, 'line 2');
  assert.equal(messages[3].content, 'dave: why though');
  assert.ok(infoLogs(world).some((line) => line.includes('0 bot turns]')));
});

test('a human reply to a conversation turn after a long time is still answered, whatever the roll and rate limit', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  const [first] = conversationRows(world);
  const reply = await world.emitMessage({ author: 'dave', content: 'what was that about', reference: first.id });
  assert.equal(reply.replies.length, 1);
  assert.equal(botRows(world).at(-1).persona, 'alice');
});

test('a deleted conversation turn ends a later chain walk like any deleted bot message', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  const [turn1, turn2] = world.discord.channel.sentMessages;
  await world.emitDelete(turn1);
  world.llm.respondWith('chain says hi');
  await world.emitMessage({ author: 'dave', content: 'why though', reference: turn2.id });
  const messages = world.llm.calls.at(-1).messages;
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.ok(!messages[1].content.includes('line 1'));
});

test('webhook display: every turn goes through the webhook under its persona\'s name with no reply-link line', async (t) => {
  const world = await newWorld(t, { env: { PERSONA_DISPLAY: 'webhook' } });
  await startConversation(world);
  const sends = [...world.discord.channel.webhooks.list.values()].flatMap((hook) => hook.sent);
  assert.deepEqual(sends.map((payload) => payload.username), ['alice-display', 'bob-display', 'alice-display', 'carol-display']);
  assert.deepEqual(sends.map((payload) => payload.content), ['line 1', 'line 2', 'line 3', 'line 4']);
  sends.forEach((payload) => assert.ok(!payload.content.includes(REPLY_LINK_PREFIX)));
  assert.deepEqual(world.discord.channel.sent, []);
  assert.equal(conversationRows(world).length, 4);
});

test('every sent turn disables mentions', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  world.discord.channel.sent.forEach((payload) => assert.deepEqual(payload.allowedMentions, { parse: [] }));
});

test('the topic prompt excludes the topic of the previous conversation, so the next one picks another candidate', async (t) => {
  const world = await newWorld(t);
  await startConversation(world);
  await world.close();
  const next = await newWorld(t);
  const camping = next.container.topicStore.currentTopics()[0];
  next.container.conversationStore.insert({
    id: 'c-earlier', topicId: camping.id, topic: 'Camping soon', premise: 'p', personas: ['alice', 'bob'], turns: ['alice', 'bob', 'alice'],
  }, BASE_TIME - 3 * DAY);
  await startConversation(next, [0.05, 0, 0.25, 0, 0, 0, 0.25]);
  const prompt = userPrompt(next.llm.calls[0]);
  assert.match(prompt, /These topics were used recently\. Do not choose them again:\n\["Camping soon"\]/);
  assert.ok(!prompt.includes('Camping trips: People plan'), 'the used bank topic is not offered');
  assert.match(prompt, /1\. Cooking dinner: People swap recipes\./);
});
