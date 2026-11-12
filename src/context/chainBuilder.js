const toBotTurn = (bot, persona) => ({
  speaker: bot.persona, content: bot.content, isPersona: bot.persona === persona,
});

export const createChainBuilder = ({
  botMessageStore, messageStore, messageFilter, userDirectory, config,
}) => {
  const { maxWalkSteps, maxContextTurns } = config.chain;

  const botAt = (id, parent) => (parent.id === id ? parent : botMessageStore.getById(id));

  // One step of the walk: the turn (or null), the next id (or null) and whether it was a bot message.
  const step = (id, parent, persona) => {
    const bot = botAt(id, parent);
    if (bot) {
      // A fallback parent has reference null, so its unknown ancestry ends the walk.
      return { turn: toBotTurn(bot, persona), next: bot.reference ?? null, isBot: true };
    }
    const raw = messageStore.getRaw(id);
    if (!raw) return null;
    const content = messageFilter.transform(raw.content);
    const turn = content === '' ? null : { speaker: raw.author, content, isPersona: false };
    return { turn, next: raw.reference ?? null, isBot: false };
  };

  const walk = (parent, persona) => {
    const seen = new Set();
    const turns = [];
    let botTurns = 0;
    let id = parent.id;
    for (let steps = 0; id && steps < maxWalkSteps && !seen.has(id); steps += 1) {
      seen.add(id);
      const visited = step(id, parent, persona);
      if (!visited) break;
      if (visited.turn) turns.push(visited.turn);
      if (visited.isBot) botTurns += 1;
      id = visited.next;
    }
    return { turns, botTurns };
  };

  const build = (target, parent) => {
    const { persona } = parent;
    if (!userDirectory.nameOf(persona)) return null;
    const { turns, botTurns } = walk(parent, persona);
    const kept = turns.reverse().slice(-(maxContextTurns - 1));
    const incoming = { speaker: target.author, content: target.content, isPersona: false };
    return { persona, turns: [...kept, incoming], botTurns };
  };

  return { build };
};
