import { TRIGGERS } from '../util/triggers.js';

const JOINER = '\n';

// The parts of one burst are a single turn.
const toBotTurn = (group, persona) => ({
  speaker: group[0].persona,
  content: group.map((bot) => bot.content).join(JOINER),
  isPersona: group[0].persona === persona,
});

const botAt = ({ botMessageStore }, id, parent) => (parent.id === id ? parent : botMessageStore.getById(id));

// A fallback parent has no stored row, so it cannot have stored siblings.
const burstOf = ({ botMessageStore }, bot) => {
  if (bot.fallback) return [bot];
  const group = botMessageStore.siblings(bot);
  return group.length > 0 ? group : [bot];
};

const humanStep = ({ messageStore, messageFilter }, id) => {
  const raw = messageStore.getRaw(id);
  if (!raw) return null;
  // A deleted human turn is skipped; the walk continues through its reference.
  const content = raw.deleted ? '' : messageFilter.transform(raw.content);
  const turn = content === '' ? null : { speaker: raw.author, content, isPersona: false };
  return { turn, next: raw.reference ?? null, isBot: false };
};

// One step of the walk: the turn (or null), the next id (or null) and whether it was a bot message.
const step = (ctx, { id, parent, persona }) => {
  const bot = botAt(ctx, id, parent);
  if (!bot) return humanStep(ctx, id);
  // A deleted bot message ends the walk (a deleted direct parent is rejected by build).
  if (bot.deleted) return null;
  // A fallback parent has reference null, so its unknown ancestry ends the walk. Conversation turns are
  // scripted, not answers in the thread, so they are shown to the model but do not count as bot turns.
  const counts = bot.trigger !== TRIGGERS.CONVERSATION;
  return { turn: toBotTurn(burstOf(ctx, bot), persona), next: bot.reference ?? null, isBot: counts };
};

const walk = (ctx, parent, persona) => {
  const seen = new Set();
  const turns = [];
  let botTurns = 0;
  let id = parent.id;
  for (let steps = 0; id && steps < ctx.config.chain.maxWalkSteps && !seen.has(id); steps += 1) {
    seen.add(id);
    const visited = step(ctx, { id, parent, persona });
    if (!visited) break;
    if (visited.turn) turns.push(visited.turn);
    if (visited.isBot) botTurns += 1;
    id = visited.next;
  }
  return { turns, botTurns };
};

// `persona` is whose turns are the model's own: the thread's persona, or another one asked to join it.
// Without a target the thread ends at the parent and no incoming turn is added.
const build = (ctx, { target, parent, persona }) => {
  if (parent.deleted || !ctx.userDirectory.nameOf(persona)) return null;
  const { turns, botTurns } = walk(ctx, parent, persona);
  const kept = turns.reverse().slice(-(ctx.config.chain.maxContextTurns - 1));
  const incoming = target ? [{ speaker: target.author, content: target.content, isPersona: false }] : [];
  return { persona, turns: [...kept, ...incoming], botTurns };
};

export const createChainBuilder = (deps) => ({
  build: (target, parent, { persona = parent.persona } = {}) => build(deps, { target, parent, persona }),
});
