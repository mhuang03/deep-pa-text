# Spec 38: Naming a persona in a mention

**Depends on:** 37. **Blocks:** none.

## Why

A ping summons a reply from the automatically picked author (spec 37). The maintainer wants to choose the author by starting the message with that person's first name, for example `@bot bob what do you think`, and wants the detection to tolerate small formatting and spelling slips.

## Behaviour

When a message pings the bot and is not a chain reply, the text left after removing the mention is checked for a leading persona name. On a match that persona answers (no automatic pick, no random roll for the persona), and the name is removed from the target text. Without a match, spec 37 applies unchanged.

- **Names.** Each user in `users.json` is known by their first name (the first word of `name`) and by their `username`.
- **The named persona may be the author of the message.** The person asked for it.
- **Name only.** `@bot bob` has no text left, so it points at another message exactly as a bare ping does (the replied-to message, else the previous one), answered as bob.
- **Chains win.** A reply to a bot message stays a chain reply by that message's persona, whatever name it starts with.
- `mention.namedPersona: false` turns the detection off.

### Matching (`src/text/personaPrefix.js`, pure)

`matchPersonaPrefix(text, users, { fuzzyMinLength, fuzzyWideMinLength }) → { persona, rest } | null`.

Everything is compared in a normal form: Unicode NFKD with combining marks removed, lower case, and only letters and digits kept. Two candidate tokens are taken from the start of the text:

- **A:** the leading run of letters and digits, after skipping any leading punctuation or spaces (`bob,what` → `bob`; `Bob's take` → `bob`);
- **B:** the first whitespace-delimited word with everything but letters and digits removed (`.valaran:` → `valaran`).

Methods, tried in this order; the first that yields exactly one user wins:

1. **Exact.** A token equals a name.
2. **Stretched letters.** They are equal after every run of a repeated character is reduced to one on both sides (`bobbb` → `bob`, `aliiice` → `alice`).
3. **Close spelling.** Token A is within an edit distance of the name, counting a swap of two neighbouring letters as one edit, and starts with the same letter. Distance 1 is allowed for names of at least `fuzzyMinLength` characters, distance 2 for names of at least `fuzzyWideMinLength`. Shorter names are never matched loosely: `mike` must not catch `make` or `like`.

A method that matches more than one user (two people share a first name, or a misspelling is equally close to two names) matches nobody and the next method is not tried: the automatic pick is used.

`rest` is the text after the matched token with a possessive `'s` and leading separators (spaces and `, : ; . ! ? -`) removed.

Known limit, accepted: a first name that is also an ordinary word (`will`, `mark`, `grace`) is taken as the name when it starts the message.

## Config

`mention.namedPersona: true`, `mention.fuzzyMinLength: 5` (integer ≥ 2), `mention.fuzzyWideMinLength: 8` (integer ≥ `fuzzyMinLength`).

## Edge cases

| Text after the mention | Users | Result |
| --- | --- | --- |
| `bob what do you think` | Bob | bob, `what do you think` |
| `Bob, what do you think` / `BOB: hi there` / `bob - thoughts` | Bob | bob |
| `bob,what do you think` / `bob's take on this` | Bob | bob, `what do you think` / `take on this` |
| `bobbb what do you think` | Bob | bob (stretched) |
| `micheal what now` / `mihcael what now` | Michael | michael (close spelling) |
| `jonathn thoughts` | Jonathan | jonathan (distance 1) |
| `jonthn thoughts` | Jonathan | jonathan (distance 2, name of 8) |
| `make me a sandwich` / `like what` | Mike | no match |
| `josé what's up` | Jose | jose |
| `.valaran what's up` | username `.valaran` | that user |
| `alex what's up` | two users named Alex | no match |
| `what does bob think` | Bob | no match (the name is not first) |
| `bob` | Bob | bob, empty rest |
| empty text | any | no match |

## Tests

- Unit: every row above; method order (an exact match for one user beats a close spelling of another); usernames; normal form (accents, case); `rest` clean-up; the mention handler (named persona used and `pickReplier` not called; name-only ping answers the pointed-at message as that persona; setting off; no match falls back to the pick); config validation.
- Scenario (`test/scenarios/mentions.test.js`): a named ping is answered by that persona even when it is the author, with the name absent from the prompt's target text; a misspelled name; a name-only ping after someone's message; a reply to a bot message that starts with another name stays a chain reply.

## Docs

README triggers section and configuration reference.

## Acceptance

`npm test` passes.
