export const createChainPolicy = ({ config, random, now }) => {
  const {
    fullDepth, decay, maxBotTurns, userCooldownMs, maxPerWindow, windowMs,
  } = config.chain;
  let busy = false;
  const lastByUser = new Map();
  let accepted = [];

  const chanceFor = (botTurns) =>
    (botTurns <= fullDepth ? 1 : decay ** (botTurns - fullDepth));

  // Entries older than their window can never block again, so every check drops them.
  const prune = () => {
    const current = now();
    accepted = accepted.filter((at) => current - at < windowMs);
    [...lastByUser].forEach(([userId, at]) => {
      if (current - at >= userCooldownMs) lastByUser.delete(userId);
    });
  };

  const limitReason = (userId) => {
    prune();
    if (lastByUser.has(userId)) return 'chain-user-cooldown';
    if (accepted.length >= maxPerWindow) return 'chain-throttled';
    return null;
  };

  const decide = ({ botTurns, userId }) => {
    if (busy) return { reply: false, reason: 'chain-busy' };
    const limited = limitReason(userId);
    if (limited) return { reply: false, reason: limited };
    if (botTurns >= maxBotTurns) return { reply: false, reason: 'chain-limit' };
    const chance = chanceFor(botTurns);
    if (chance >= 1) return { reply: true, reason: 'chain-guaranteed', chance };
    const roll = random();
    return { reply: roll <= chance, reason: roll <= chance ? 'chain-accepted' : 'chain-roll', chance, roll };
  };

  // Recorded on begin, so a refused or failed decision never uses up the allowance.
  const begin = ({ userId }) => {
    busy = true;
    lastByUser.set(userId, now());
    accepted.push(now());
  };

  return {
    decide,
    begin,
    end: () => {
      busy = false;
    },
  };
};
