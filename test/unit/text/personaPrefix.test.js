import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPersonaPrefix } from '../../../src/text/personaPrefix.js';

const LIMITS = { fuzzyMinLength: 5, fuzzyWideMinLength: 8 };
const USERS = [
  { username: 'bobster', name: 'Bob Example' },
  { username: 'mikey', name: 'Mike Example' },
  { username: 'mjordan', name: 'Michael Example' },
  { username: 'jon_t', name: 'Jonathan Example' },
  { username: '.valaran', name: 'Val Example' },
  { username: 'jose99', name: 'José Example' },
];
const match = (text, users = USERS) => matchPersonaPrefix(text, users, LIMITS);

test('an exact first name at the start is matched and removed, whatever the case or punctuation', () => {
  assert.deepEqual(match('bob what do you think'), { persona: 'bobster', rest: 'what do you think' });
  assert.deepEqual(match('Bob, what do you think'), { persona: 'bobster', rest: 'what do you think' });
  assert.deepEqual(match('BOB: hi there'), { persona: 'bobster', rest: 'hi there' });
  assert.deepEqual(match('bob - thoughts'), { persona: 'bobster', rest: 'thoughts' });
  assert.deepEqual(match('  bob   what'), { persona: 'bobster', rest: 'what' });
});

test('a name glued to punctuation or a possessive is still the name', () => {
  assert.deepEqual(match('bob,what do you think'), { persona: 'bobster', rest: 'what do you think' });
  assert.deepEqual(match("bob's take on this"), { persona: 'bobster', rest: 'take on this' });
  assert.deepEqual(match('bob’s take'), { persona: 'bobster', rest: 'take' });
});

test('a username is matched too, with or without its punctuation', () => {
  assert.deepEqual(match(".valaran what's up"), { persona: '.valaran', rest: "what's up" });
  assert.deepEqual(match('valaran: hello'), { persona: '.valaran', rest: 'hello' });
  assert.deepEqual(match('jon_t hello'), { persona: 'jon_t', rest: 'hello' });
});

test('stretched letters are reduced before comparing', () => {
  assert.deepEqual(match('bobbb what do you think'), { persona: 'bobster', rest: 'what do you think' });
  assert.deepEqual(match('miiike hey'), { persona: 'mikey', rest: 'hey' });
});

test('a close spelling matches a name long enough to be safe', () => {
  assert.equal(match('micheal what now').persona, 'mjordan');
  assert.equal(match('mihcael what now').persona, 'mjordan');
  assert.equal(match('jonathn thoughts').persona, 'jon_t');
  assert.equal(match('jonthn thoughts').persona, 'jon_t');
  assert.deepEqual(match('micheal, what now').rest, 'what now');
});

test('short names are never matched loosely, and a different first letter never matches', () => {
  assert.equal(match('make me a sandwich'), null);
  assert.equal(match('like what'), null);
  assert.equal(match('bib what'), null);
  assert.equal(match('nichael what'), null);
  assert.equal(match('jon what'), null);
});

test('accents are ignored on both sides', () => {
  assert.equal(match("jose what's up").persona, 'jose99');
  assert.equal(match("José what's up").persona, 'jose99');
});

test('a name that is not first, or no text, matches nobody', () => {
  assert.equal(match('what does bob think'), null);
  assert.equal(match(''), null);
  assert.equal(match('   '), null);
  assert.equal(match(null), null);
  assert.equal(match('?!'), null);
});

test('a name alone leaves an empty rest', () => {
  assert.deepEqual(match('bob'), { persona: 'bobster', rest: '' });
  assert.deepEqual(match('bob?'), { persona: 'bobster', rest: '' });
});

test('a name two people share chooses nobody', () => {
  const users = [{ username: 'alex1', name: 'Alex One' }, { username: 'alex2', name: 'Alex Two' }];
  assert.equal(match("alex what's up", users), null);
  assert.deepEqual(match('alex2 hello', users), { persona: 'alex2', rest: 'hello' });
});

test('an exact match for one person beats a close spelling of another', () => {
  const users = [{ username: 'u1', name: 'Marcus Example' }, { username: 'u2', name: 'Marcas Example' }];
  assert.equal(match('marcus hello', users).persona, 'u1');
  assert.equal(match('marcis hello', users), null);
});

test('users without a usable name are skipped', () => {
  assert.equal(match('hello there', [{ username: '', name: '' }]), null);
});
