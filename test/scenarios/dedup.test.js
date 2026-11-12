import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../support/world.js';
import { BASE_TIME } from '../support/fixtures.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
const HELLO = 'hello there friends';
const BOT_LINE = 'sounds like a plan to me';
const FREQUENT_INTRO = 'The user sends some of these messages often.';
const AVOID_INTRO = 'recently sent these messages in the channel';
const SPELLINGS = [
  ...Array(3).fill('see you tomorrow'), ...Array(2).fill('See you tomorrow!'), 'see you tomorrowww',
];

const newWorld = async (t) => {
  const world = await createWorld({ random: 0 });
  t.after(() => world.close());
  return world;
};

const userPrompt = (world, index = 0) => world.llm.calls[index].messages[1].content;

const seedHabit = async (world) => {
  const start = BASE_TIME - 2 * DAY;
  await world.seed([
    { id: 'p1', author: 'dave', content: HELLO, timestamp: start },
    ...SPELLINGS.map((content, i) => ({
      id: `h${i}`, author: 'carol', content, timestamp: start + (i + 1) * MINUTE, reference: i === 0 ? 'p1' : null,
    })),
    { id: 'x1', author: 'carol', content: 'a completely different sentence', timestamp: start + 10 * MINUTE },
  ]);
};

const countMatches = (text, pattern) => (text.match(pattern) ?? []).length;

test('a phrase habitually sent in several spellings appears once in the examples with a combined count', async (t) => {
  const world = await newWorld(t);
  await seedHabit(world);
  await world.emitMessage({ content: HELLO });
  const prompt = userPrompt(world);
  const [examples, frequent] = prompt.split(FREQUENT_INTRO);
  assert.equal(countMatches(examples, /see you tomorrow/gi), 1);
  assert.match(frequent, /\[\{"text":"see you tomorrow","times":6\}\]/);
  assert.ok(!prompt.includes(AVOID_INTRO));
});

test('after a bot reply the next prompt tells the model not to repeat it', async (t) => {
  const world = await newWorld(t);
  await seedHabit(world);
  world.llm.respondWith(BOT_LINE);
  await world.emitMessage({ content: HELLO });
  await world.advance(10 * MINUTE);
  await world.emitMessage({ content: HELLO });
  const second = userPrompt(world, 1);
  assert.ok(second.endsWith(`${JSON.stringify([BOT_LINE])}`));
  assert.ok(second.includes(AVOID_INTRO));
});
