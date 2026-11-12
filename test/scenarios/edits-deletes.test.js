import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const HOUR = 3_600_000;
const T0 = BASE_TIME - 10 * HOUR;
const QUERY = { author: 'bob', content: 'see you at the park', timestamp: BASE_TIME };

const newWorld = async (t, options) => {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
};
const m = (id, author, content, timestamp, reference = null) => ({ id, author, content, timestamp, reference });
const filtered = (world) => world.sqlite.all('SELECT id, content, deleted_at, source_id, timestamp FROM filtered_messages ORDER BY rowid');
const revisions = (world) => world.sqlite.all('SELECT * FROM message_revisions ORDER BY rowid');
const everything = async (world, author = 'alice') =>
  (await world.subject.semanticSearch(author, QUERY)).flat();
const prompt = (world) => world.llm.calls.at(-1).messages.map((x) => x.content).join('\n');
const chromaIds = (world) => [...world.chroma.collection('message_embeddings').rows.keys()];

test('a deleted message disappears from retrieval but every row survives', async (t) => {
  const world = await newWorld(t);
  await world.seed([m('1', 'alice', 'see you at the park today', T0), m('2', 'alice', 'see you at the pool', T0 + 1)]);
  assert.ok((await everything(world)).includes('see you at the park today'));
  await world.emitDelete('1');
  const texts = await everything(world);
  assert.equal(texts.includes('see you at the park today'), false);
  assert.ok(texts.includes('see you at the pool'));
  assert.equal(world.sqlite.all('SELECT id FROM messages').length, 2);
  assert.equal(filtered(world).length, 2);
  assert.deepEqual(chromaIds(world).sort(), ['1', '2']);
  assert.equal(world.sqlite.get('SELECT deleted_at FROM messages WHERE id = ?', '1').deleted_at, BASE_TIME);
  assert.deepEqual(await world.subject.randomSearch('alice'), ['see you at the pool']);
});

test('deleting an unknown id or the same id twice is harmless and keeps the first timestamp', async (t) => {
  const world = await newWorld(t);
  await world.seed([m('1', 'alice', 'see you at the park today', T0)]);
  await world.emitDelete('nope');
  await world.emitDelete('1');
  await world.advance(1000);
  await world.emitDelete('1');
  assert.equal(world.sqlite.get('SELECT deleted_at FROM filtered_messages WHERE id = ?', '1').deleted_at, BASE_TIME);
  assert.deepEqual(world.errors, []);
});

test('a bulk delete hides every listed message', async (t) => {
  const world = await newWorld(t);
  await world.seed([
    m('1', 'alice', 'park text number one', T0), m('2', 'alice', 'park text number two', T0 + 1),
    m('3', 'alice', 'park text number three', T0 + 2), m('4', 'alice', 'park text number four', T0 + 3),
  ]);
  await world.emitBulkDelete(['1', '2', '3']);
  const texts = await everything(world);
  assert.ok(texts.includes('park text number four'));
  assert.equal(texts.some((text) => /number (one|two|three)$/.test(text)), false);
  assert.equal(world.sqlite.all('SELECT id FROM filtered_messages WHERE deleted_at IS NOT NULL').length, 3);
});

test('deletes and edits in another channel are ignored', async (t) => {
  const world = await newWorld(t);
  await world.seed([m('1', 'alice', 'see you at the park today', T0)]);
  const other = world.discord.makeMessage({ id: '1', author: 'alice', content: 'changed words here', channel: world.discord.otherChannel });
  await world.emitDelete(other);
  await world.emitEdit(other, { content: 'changed words here', editedTimestamp: BASE_TIME });
  assert.equal(world.sqlite.get('SELECT deleted_at FROM filtered_messages WHERE id = ?', '1').deleted_at, null);
  assert.deepEqual(revisions(world), []);
});

test('an edit appends a revision and a new corpus row, hides the old text and keeps the original raw text', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ author: 'alice', content: 'see you at 5', timestamp: T0 });
  await world.emitEdit(message, { content: 'see you at 6', editedTimestamp: T0 + 1000 });
  assert.deepEqual(revisions(world), [{ message_id: message.id, content: 'see you at 6', edited_at: T0 + 1000 }]);
  const rows = filtered(world);
  assert.equal(rows[0].deleted_at, T0 + 1000);
  assert.deepEqual([rows[1].id, rows[1].source_id, rows[1].timestamp, rows[1].deleted_at],
    [`${message.id}:${T0 + 1000}`, message.id, T0, null]);
  assert.equal(world.sqlite.get('SELECT content FROM messages WHERE id = ?', message.id).content, 'see you at 5');
  assert.deepEqual(chromaIds(world).sort(), [message.id, `${message.id}:${T0 + 1000}`].sort());
  const texts = await everything(world);
  assert.ok(texts.includes('see you at 6'));
  assert.equal(texts.includes('see you at 5'), false);
});

test('an edit of an uncached (partial) message is fetched and recorded', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ author: 'alice', content: 'see you at 5', timestamp: T0 });
  await world.emitEdit(message, { content: 'see you at 7', editedTimestamp: T0 + 5, partial: true });
  assert.equal(revisions(world)[0].content, 'see you at 7');
});

test('a second edit hides the first edit row too', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ author: 'alice', content: 'version one text', timestamp: T0 });
  await world.emitEdit(message, { content: 'version two text', editedTimestamp: T0 + 10 });
  await world.emitEdit(message, { content: 'version three text', editedTimestamp: T0 + 20 });
  assert.equal(revisions(world).length, 2);
  assert.deepEqual(filtered(world).map((r) => r.deleted_at === null), [false, false, true]);
});

test('repeated update events change nothing: same edit time, or unchanged content', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ author: 'alice', content: 'version one text', timestamp: T0 });
  await world.emitEdit(message, { content: 'version one text', editedTimestamp: T0 + 5 });
  assert.deepEqual(revisions(world), []);
  await world.emitEdit(message, { content: 'version two text', editedTimestamp: T0 + 10 });
  await world.emitEdit(message, { content: 'version two text', editedTimestamp: T0 + 10 });
  assert.equal(revisions(world).length, 1);
  assert.equal(filtered(world).length, 2);
});

test('an edit to content the filter drops hides the old row and adds none', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ author: 'alice', content: 'see you at the park', timestamp: T0 });
  await world.emitEdit(message, { content: 'hi', editedTimestamp: T0 + 10 });
  assert.equal(revisions(world).length, 1);
  assert.equal(filtered(world).length, 1);
  assert.equal(filtered(world)[0].deleted_at, T0 + 10);
});

test('an edit by a non-approved author stores a revision and no corpus row', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ author: 'mallory', content: 'outsider words here', timestamp: T0 });
  await world.emitEdit(message, { content: 'outsider words changed', editedTimestamp: T0 + 10 });
  assert.equal(revisions(world).length, 1);
  assert.deepEqual(filtered(world), []);
});

test('edit then delete hides every corpus row of the message', async (t) => {
  const world = await newWorld(t);
  const message = await world.emitMessage({ author: 'alice', content: 'version one text', timestamp: T0 });
  await world.emitEdit(message, { content: 'version two text', editedTimestamp: T0 + 10 });
  await world.emitDelete(message);
  assert.ok(filtered(world).every((row) => row.deleted_at !== null));
  assert.equal((await everything(world)).some((text) => text.startsWith('version')), false);
});

test('an edit of a message the bot never saw is recorded as a new message', async (t) => {
  const world = await newWorld(t);
  const message = world.discord.makeMessage({ author: 'alice', content: 'fresh unseen words', timestamp: T0 });
  await world.emitEdit(message, { content: 'fresh unseen words', editedTimestamp: T0 + 10 });
  assert.equal(world.sqlite.get('SELECT content FROM messages WHERE id = ?', message.id).content, 'fresh unseen words');
  assert.equal(filtered(world).length, 1);
});

test('edits and deletes never trigger a reply or count as activity', async (t) => {
  const world = await newWorld(t, { random: 0 });
  const message = await world.emitMessage({ author: 'alice', content: 'see you at 5', timestamp: T0 });
  const before = message.replies.length;
  const sent = world.discord.channel.sent.length;
  await world.emitEdit(message, { content: 'see you at 6', editedTimestamp: T0 + 10 });
  await world.emitDelete(message);
  assert.equal(message.replies.length, before);
  assert.equal(world.discord.channel.sent.length, sent);
});

test('a reply stored before its parent was edited shows the parent new text; a deleted parent leaves no them', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  const parent = await world.emitMessage({ author: 'alice', content: 'parent says old words', timestamp: T0 });
  await world.emitMessage({ author: 'bob', content: 'bob answers the parent', timestamp: T0 + 1000, reference: parent.id });
  await world.emitEdit(parent, { content: 'parent says new words', editedTimestamp: T0 + 2000 });
  await world.subject.getRAGResponse('bob', { ...QUERY, content: 'bob answers the parent again' });
  assert.match(prompt(world), /parent says new words/);
  assert.doesNotMatch(prompt(world), /parent says old words/);
  await world.emitDelete(parent);
  await world.subject.getRAGResponse('bob', { ...QUERY, content: 'bob answers the parent again' });
  assert.match(prompt(world), /bob answers the parent/);
  assert.doesNotMatch(prompt(world), /parent says new words/);
});

test('a new reply to an edited message keeps it as its reference', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  const parent = await world.emitMessage({ author: 'alice', content: 'parent says old words', timestamp: T0 });
  await world.emitEdit(parent, { content: 'parent says new words', editedTimestamp: T0 + 2000 });
  await world.emitMessage({ author: 'bob', content: 'bob answers later on', timestamp: T0 + 3000, reference: parent.id });
  assert.equal(world.sqlite.get('SELECT reference FROM filtered_messages WHERE content = ?', 'bob answers later on').reference, parent.id);
});

test('a reply sent after its parent was deleted infers its reference from the previous visible message', async (t) => {
  const world = await newWorld(t, { random: 0.99 });
  const first = await world.emitMessage({ author: 'alice', content: 'the first visible words', timestamp: T0 });
  const gone = await world.emitMessage({ author: 'carol', content: 'this one gets deleted', timestamp: T0 + 1000 });
  await world.emitDelete(gone);
  await world.emitMessage({ author: 'bob', content: 'bob answers the deleted', timestamp: T0 + 2000, reference: gone.id });
  assert.equal(world.sqlite.get('SELECT reference FROM filtered_messages WHERE content = ?', 'bob answers the deleted').reference, first.id);
});

test('a deleted bot message leaves the avoid-repeats list and a reply to it starts no chain', async (t) => {
  const world = await newWorld(t, { random: 0 });
  world.llm.respondWith('unique bot sentence');
  await world.emitMessage({ author: 'alice', content: 'hello there friends' });
  const row = world.sqlite.get('SELECT id FROM bot_messages');
  await world.subject.getRAGResponse('bob', { ...QUERY });
  assert.match(prompt(world), /unique bot sentence/);
  await world.emitDelete(row.id);
  assert.equal(world.sqlite.get('SELECT deleted_at FROM bot_messages WHERE id = ?', row.id).deleted_at, BASE_TIME);
  await world.subject.getRAGResponse('bob', { ...QUERY });
  assert.doesNotMatch(prompt(world), /unique bot sentence/);
  world.setRandom(0.99);
  await world.emitMessage({ author: 'alice', content: 'replying to a removed one', reference: row.id });
  assert.equal(world.sqlite.all("SELECT id FROM bot_messages WHERE trigger = 'chain'").length, 0);
});

const replyRows = (world) => [...world.chroma.collection('message_reply_embeddings').rows.keys()];

test('a message dropped by the filter and kept through an edit gets an anchor row that replies can reference', async (t) => {
  const world = await newWorld(t);
  const link = await world.emitMessage({ author: 'alice', content: 'https://example.com', timestamp: T0 });
  assert.deepEqual(filtered(world), []);
  await world.emitEdit(link, { content: 'finally got it working', editedTimestamp: T0 + 1000 });
  const [anchor] = filtered(world);
  assert.deepEqual([anchor.id, anchor.source_id, anchor.deleted_at], [link.id, null, null]);
  await world.emitMessage({ author: 'bob', content: 'nice one that is great', timestamp: T0 + 2000, reference: link.id });
  const reply = world.sqlite.get('SELECT reference FROM filtered_messages WHERE content = ?', 'nice one that is great');
  assert.equal(reply.reference, link.id);
  assert.ok(replyRows(world).length > 0, 'the reply row exists');
  await world.emitEdit(link, { content: 'finally got it working, really', editedTimestamp: T0 + 3000 });
  const rows = filtered(world).filter((r) => r.content.startsWith('finally'));
  assert.deepEqual(rows.map((r) => [r.id, r.source_id, r.deleted_at === null]), [
    [link.id, null, false], [`${link.id}:${T0 + 3000}`, link.id, true],
  ]);
});

test('an edit keeps the reference of the message, including none for a reply to a bot message', async (t) => {
  const world = await newWorld(t);
  const first = await world.emitMessage({ author: 'alice', content: 'does anyone want lunch today', timestamp: T0 });
  const reply = await world.emitMessage({
    author: 'bob', content: 'sure where should we go', timestamp: T0 + 1000, reference: first.id,
  });
  await world.emitMessage({ author: 'carol', content: 'something else entirely now', timestamp: T0 + 2000 });
  await world.emitEdit(reply, { content: 'sure where do we go', editedTimestamp: T0 + 3000 });
  const edited = world.sqlite.get('SELECT reference FROM filtered_messages WHERE content = ?', 'sure where do we go');
  assert.equal(edited.reference, first.id);
});

const MINUTE = 60_000;
const STARTERS_INTRO = 'Here are messages this user has sent to start a conversation';
const FREQUENT_INTRO = 'The user sends some of these messages often.';

// The JSON list on the line after an intro sentence; list order is random.
const listAfter = (text, intro) => {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.startsWith(intro));
  return at === -1 ? null : JSON.parse(lines[at + 1]);
};

// dave opens at T0 - 10h (always a starter). bob and carol talk, then dave answers 40 minutes after carol,
// so that message is mid-conversation unless the one before it is gone.
const revivePromptAfter = async (deletedIds) => {
  const world = await createWorld();
  try {
    return await runRevive(world, deletedIds);
  } finally {
    await world.close();
  }
};

const runRevive = async (world, deletedIds) => {
  const start = BASE_TIME - 48 * HOUR;
  await world.seed([
    m('o0', 'dave', 'a very first opener from dave', start - 10 * HOUR),
    m('a1', 'bob', 'anybody here this morning', start),
    m('a2', 'carol', 'yes i am around here', start + 40 * MINUTE),
    m('d1', 'dave', 'answering after forty minutes', start + 80 * MINUTE),
  ]);
  await world.ready();
  for (const id of deletedIds) await world.emitDelete(id);
  await world.emitMessage({ id: 'tail', author: 'alice', content: 'who wants lunch', timestamp: BASE_TIME });
  await world.advance(3 * HOUR + 10 * MINUTE);
  assert.equal(world.llm.calls.length, 1, 'a revive was sent');
  return world.llm.calls[0].messages[1].content;
};

test('deleting the message before a would-be starter makes the next author\'s message a starter', async () => {
  const kept = listAfter(await revivePromptAfter([]), STARTERS_INTRO);
  assert.deepEqual(kept, ['a very first opener from dave']);
  const afterDelete = listAfter(await revivePromptAfter(['a2']), STARTERS_INTRO);
  assert.deepEqual([...afterDelete].sort(), ['a very first opener from dave', 'answering after forty minutes']);
});

const SPELLINGS = [...Array(3).fill('see you tomorrow'), ...Array(2).fill('See you tomorrow!'), 'see you tomorrowww'];

const habitPrompt = async (deletedIds) => {
  const world = await createWorld({ random: 0 });
  try {
    return await runHabit(world, deletedIds);
  } finally {
    await world.close();
  }
};

const runHabit = async (world, deletedIds) => {
  const start = BASE_TIME - 2 * 24 * HOUR;
  await world.seed([
    m('p1', 'dave', 'hello there friends', start),
    ...SPELLINGS.map((content, i) => m(`h${i}`, 'carol', content, start + (i + 1) * MINUTE, i === 0 ? 'p1' : null)),
  ]);
  for (const id of deletedIds) await world.emitDelete(id);
  await world.emitMessage({ content: 'hello there friends' });
  return world.llm.calls[0].messages[1].content;
};

test('deleted messages drop out of the frequent-phrase counts', async () => {
  const full = await habitPrompt([]);
  assert.match(full.split(FREQUENT_INTRO)[1], /\[\{"text":"see you tomorrow","times":6\}\]/);
  const fewer = await habitPrompt(['h4', 'h5']);
  assert.match(fewer.split(FREQUENT_INTRO)[1], /\[\{"text":"see you tomorrow","times":4\}\]/);
  const below = await habitPrompt(['h1', 'h2', 'h3', 'h4']);
  assert.equal(below.includes(FREQUENT_INTRO), false);
});
