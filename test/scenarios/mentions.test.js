import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const PING = '<@bot-user>';
const QUESTION = 'what do we think about this';

const newWorld = async (t, options = { random: 0.99 }) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};

const botRows = (world) => world.sqlite.all('SELECT * FROM bot_messages ORDER BY rowid');
const lastPrompt = (world) => world.llm.calls.at(-1).messages.at(-1).content;
const personaOf = (message) => message.replies[0].embeds.at(-1).data.author.name;
const logged = (world, text) => world.logs.log.some((args) => String(args[0]).includes(text));

test('a ping is answered despite a losing roll, with the mention removed and never as the author', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ author: 'alice', content: `${PING} ${QUESTION}` });
  assert.equal(message.replies.length, 1);
  assert.notEqual(personaOf(message), 'alice');
  assert.ok(lastPrompt(world).includes(`"${QUESTION}"`));
  assert.ok(!lastPrompt(world).includes('bot-user'));
  const [row] = botRows(world);
  assert.deepEqual({ trigger: row.trigger, reference: row.reference }, { trigger: 'mention', reference: message.id });
});

test('a ping is answered inside the auto-reply rate-limit window, and ten in a row are all answered', async (t) => {
  const world = await newWorld(t, { random: 0 });
  await world.emitMessage({ author: 'alice', content: 'hello there friends' });
  assert.equal(botRows(world).length, 1);
  for (let i = 0; i < 10; i += 1) {
    const ping = await world.emitMessage({ author: 'alice', content: `<@!bot-user> and question number ${i}` });
    assert.equal(ping.replies.length, 1);
  }
  assert.equal(botRows(world).filter((row) => row.trigger === 'mention').length, 10);
});

test('a short ping is answered', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ author: 'alice', content: `${PING} why` });
  assert.equal(message.replies.length, 1);
});

test('a bare ping answers the previous message and replies to the ping', async (t) => {
  const world = await newWorld(t);
  await world.emitMessage({ author: 'carol', content: 'anyone want to get food later' });
  await world.advance(1000);
  const ping = await world.emitMessage({ author: 'alice', content: PING });
  assert.equal(ping.replies.length, 1);
  assert.ok(lastPrompt(world).includes('anyone want to get food later'));
  assert.notEqual(personaOf(ping), 'carol');
  assert.equal(botRows(world).at(-1).trigger, 'mention');
});

test('a bare ping written as a reply answers the referenced message', async (t) => {
  const world = await newWorld(t);
  const older = await world.emitMessage({ author: 'dave', content: 'the older message people forgot' });
  await world.advance(1000);
  await world.emitMessage({ author: 'carol', content: 'something else entirely different' });
  await world.advance(1000);
  const ping = await world.emitMessage({ author: 'alice', content: PING, reference: older.id });
  assert.equal(ping.replies.length, 1);
  assert.ok(lastPrompt(world).includes('"the older message people forgot"'));
});

test('a bare ping with nothing before it makes no LLM call and is logged', async (t) => {
  const world = await newWorld(t);
  const ping = await world.emitMessage({ author: 'alice', content: PING });
  assert.equal(ping.replies.length, 0);
  assert.equal(world.llm.calls.length, 0);
  assert.ok(logged(world, '[MENTION: nothing to reply to]'));
});

test('a reply to a bot message that also pings the bot is one chain reply by that persona', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const root = await world.emitMessage({ author: 'alice', content: 'hello there friends' });
  const persona = personaOf(root);
  world.setRandom(0.99);
  const reply = await world.emitMessage({ author: 'alice', content: `${PING} say more`, reference: botRows(world)[0].id });
  assert.equal(reply.replies.length, 1);
  assert.equal(personaOf(reply), persona);
  assert.deepEqual(botRows(world).map((row) => row.trigger), ['auto', 'chain']);
});

test('MENTION_REPLIES=false sends a ping through the random path', async (t) => {
  const world = await newWorld(t, { random: 0.99, env: { MENTION_REPLIES: 'false' } });
  const ping = await world.emitMessage({ author: 'alice', content: `${PING} ${QUESTION}` });
  assert.equal(ping.replies.length, 0);
  assert.equal(world.llm.calls.length, 0);
});

test('a ping is answered while an auto reply is still being generated', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const release = world.llm.hold();
  const first = await world.emitMessage({ author: 'alice', content: 'hello there friends' });
  assert.equal(first.replies.length, 0);
  const ping = await world.emitMessage({ author: 'dave', content: `${PING} are you there` });
  assert.equal(ping.replies.length, 1);
  release();
  await world.settle();
  assert.equal(first.replies.length, 1);
});

test('a mention reply rate-limits auto replies but does not count as the bot speaking last', async (t) => {
  const world = await newWorld(t);
  await world.ready();
  await world.emitMessage({ author: 'alice', content: `${PING} ${QUESTION}` });
  world.setRandom(0);
  await world.advance(MINUTE);
  const next = await world.emitMessage({ author: 'dave', content: 'an unrelated message here', timestamp: world.now() - MINUTE });
  assert.equal(next.replies.length, 0);
  assert.ok(logged(world, 'rate limited'));
  world.setRandom(0.99);
  await world.advance(3 * HOUR + 10 * MINUTE);
  assert.equal(world.discord.channel.sent.length, 1);
});

test('a failed mention reply is logged with its trigger and the next ping still works', async (t) => {
  const world = await newWorld(t);
  world.llm.respondWith([new Error('llm down'), 'back again']);
  const failed = await world.emitMessage({ author: 'alice', content: `${PING} ${QUESTION}` });
  assert.equal(failed.replies.length, 0);
  assert.ok(world.logs.error.some((args) => String(args[0]).includes('mention reply')));
  const next = await world.emitMessage({ author: 'alice', content: `${PING} ${QUESTION}` });
  assert.equal(next.replies.length, 1);
});

test('a ping that starts with a first name is answered by that persona, even its own author, without the name in the target', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ author: 'alice', content: `${PING} Alice, ${QUESTION}` });
  assert.equal(personaOf(message), 'alice');
  assert.ok(lastPrompt(world).includes(`"${QUESTION}"`));
  const other = await world.emitMessage({ author: 'alice', content: `${PING} carol ${QUESTION}` });
  assert.equal(personaOf(other), 'carol');
});

test('a misspelled first name still chooses the persona', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ author: 'bob', content: `${PING} caorl whats the plan tonight` });
  assert.equal(personaOf(message), 'carol');
});

test('a name alone answers the previous message as that persona', async (t) => {
  const world = await newWorld(t);
  await world.emitMessage({ author: 'carol', content: 'anyone want to get food later' });
  await world.advance(1000);
  const ping = await world.emitMessage({ author: 'alice', content: `${PING} dave` });
  assert.equal(personaOf(ping), 'dave');
  assert.ok(lastPrompt(world).includes('anyone want to get food later'));
});

const requestOf = (world) => world.llm.calls.at(-1).messages;
const OTHERS = ['bob', 'carol', 'dave'];

// An auto reply to alice, then a roll that lets nothing else reply by chance.
const startThread = async (world) => {
  const root = await world.emitMessage({ author: 'alice', content: 'hello there friends' });
  world.setRandom(0.99);
  return { root, persona: personaOf(root), bot: botRows(world)[0] };
};

test('a pinged reply to a bot message that names another persona is answered by it inside the thread', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const { persona, bot } = await startThread(world);
  const other = OTHERS.find((name) => name !== persona);
  const reply = await world.emitMessage({ author: 'alice', content: `${PING} ${other} what about you`, reference: bot.id });
  assert.equal(personaOf(reply), other);
  const messages = requestOf(world);
  assert.equal(messages.some((m) => m.role === 'assistant'), false);
  assert.ok(messages.some((m) => m.role === 'user' && m.content.includes(`${persona}: ${bot.content}`)));
  assert.ok(messages.at(-1).content.endsWith('alice: what about you'));
  assert.ok(JSON.stringify(messages).includes('hello there friends'));
  const row = botRows(world).at(-1);
  assert.deepEqual({ persona: row.persona, trigger: row.trigger, reference: row.reference }, { persona: other, trigger: 'chain', reference: reply.id });
});

test('a plain reply to the joined persona continues as it and still sees the whole thread', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const { persona, bot } = await startThread(world);
  const other = OTHERS.find((name) => name !== persona);
  await world.emitMessage({ author: 'alice', content: `${PING} ${other} what about you`, reference: bot.id });
  const joined = botRows(world).at(-1);
  const next = await world.emitMessage({ author: 'dave', content: 'go on then', reference: joined.id });
  assert.equal(personaOf(next), other);
  const messages = requestOf(world);
  assert.ok(messages.some((m) => m.role === 'assistant' && m.content === joined.content));
  assert.ok(messages.some((m) => m.role === 'user' && m.content.includes(`${persona}: ${bot.content}`)));
});

test('only another name in a pinged reply answers the bot message itself', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const { persona, bot } = await startThread(world);
  const other = OTHERS.find((name) => name !== persona);
  const reply = await world.emitMessage({ author: 'alice', content: `${PING} ${other}`, reference: bot.id });
  assert.equal(personaOf(reply), other);
  assert.ok(requestOf(world).at(-1).content.endsWith(`${persona}: ${bot.content}`));
  assert.deepEqual(
    { trigger: botRows(world).at(-1).trigger, reference: botRows(world).at(-1).reference },
    { trigger: 'chain', reference: bot.id },
  );
});

test('naming the thread persona, misspelling another, and a name without a ping', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const { persona, bot } = await startThread(world);
  const same = await world.emitMessage({ author: 'alice', content: `${PING} ${persona} what else`, reference: bot.id });
  assert.equal(personaOf(same), persona);
  assert.ok(requestOf(world).at(-1).content.endsWith('alice: what else'));
  const typo = await world.emitMessage({ author: 'alice', content: `${PING} caorl say more`, reference: bot.id });
  assert.equal(personaOf(typo), persona === 'carol' ? persona : 'carol');
  const other = OTHERS.find((name) => name !== persona);
  const unpinged = await world.emitMessage({ author: 'alice', content: `${other} say more`, reference: bot.id });
  assert.equal(personaOf(unpinged), persona);
  assert.ok(requestOf(world).at(-1).content.endsWith(`alice: ${other} say more`));
});
