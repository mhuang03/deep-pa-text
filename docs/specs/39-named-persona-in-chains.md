# Spec 39: A named persona joins an existing chain

**Depends on:** 38. **Blocks:** none. Supersedes the "chains win" rule of spec 38.

## Why

A reply to a bot message continues the thread as that message's persona (spec 21). Spec 38 let a ping name its persona, but kept the thread's persona whenever the ping was a reply to a bot message. The maintainer wants the named persona to answer there too, inside the same thread and with all of its context.

## Behaviour

For a human message that replies to a bot message **and** pings the bot in its text, the text after the ping is read as in spec 38 (`mention.namedPersona` on):

- **A different persona is named.** That persona replies in the thread. The chain is built by the same walk, but from the named persona's point of view: its own earlier messages in the thread (if any) are its turns, and every other message, including the thread persona's bot messages, is someone else's turn labelled with the speaker. The name is removed from the incoming turn and from the retrieval target.
- **The thread's own persona is named, or no name is given.** The thread continues as before; a leading name is still removed from the text.
- **Only a name** (`@bot carol` in reply to bob's bot message): the named persona answers the bot message itself. The chain ends with that bot message, which is also the retrieval target; no incoming turn is added. If the name is the thread's own persona there is nothing new to answer in the thread, so the message is handled as an ordinary named ping (spec 38).
- Without a ping in the text, a reply to a bot message is unchanged: a leading name means nothing.
- The reply is a chain reply in every respect: trigger `chain`, sent as a Discord reply to the human's message, always answered, arming only the auto-reply rate limit. Its stored reference is the message it answers (the human's message, or the bot message for a name-only ping), so later replies walk back through the whole thread.
- A named persona that is no longer in `users.json` cannot occur (names are matched against the directory). The thread persona no longer has to be in the directory when another persona is named.

### Interfaces

- `chainBuilder.build(target, parent, { persona = parent.persona } = {})`: `persona` decides whose turns are the model's own. `target` may be `null`, in which case no incoming turn is appended.
- `buildChain(deps, { message, record, parent })` in `src/bot/handlers/messageChain.js` reads the request with `readRequest` (exported from `messageMention.js`) when the message pings the bot.

## Edge cases

- Thread `alice → bob(bot) → alice: "@bot carol what about you"`: carol answers; the LLM request has bob's message as a user turn `bob: …`, the incoming turn is `alice: what about you`, and no assistant turn.
- Carol already spoke earlier in the thread: her messages are assistant turns, bob's are user turns.
- `@bot carol` alone in reply to bob's bot message: carol answers; the last turn is `bob: …`; the stored reference is bob's bot message id.
- `@bot bob what else` in reply to bob's bot message: bob continues; the incoming turn is `what else`.
- `@bot bob` alone in reply to bob's bot message: handled as a named ping; bob answers the bot message.
- `@bot caorl say more` (misspelled) in reply to bob's bot message: carol.
- `carol say more` in reply to bob's bot message with no ping: bob, and the text is unchanged.
- `mention.namedPersona: false` or `CHAIN_REPLIES=false`: as before this spec.
- After carol's reply, a plain reply to carol's message continues as carol and sees the whole thread, bob's messages included.

## Tests

- Unit: `chainBuilder.build` with a persona override (roles flip, own earlier turns, departed thread persona allowed) and with a `null` target; `buildChain` (each bullet above); the message handler passes the message through.
- Scenario (`test/scenarios/mentions.test.js`): the edge cases above, asserting the persona on the reply, the roles and text of the LLM request, the stored trigger and reference.

## Docs

README mention section.

## Acceptance

`npm test` passes.
