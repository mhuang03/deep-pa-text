const chanceFor = ({ fullDepth, decay }, botTurns) =>
  (botTurns <= fullDepth ? 1 : decay ** (botTurns - fullDepth));

// Entries older than their window can never block again, so every check drops them.
const prune = ({ rules, state, now }) => {
  const current = now();
  state.accepted = state.accepted.filter((at) => current - at < rules.windowMs);
  [...state.lastByUser].forEach(([userId, at]) => {
    if (current - at >= rules.userCooldownMs) state.lastByUser.delete(userId);
  });
};

const limitReason = (ctx, userId) => {
  prune(ctx);
  if (ctx.state.lastByUser.has(userId)) return 'chain-user-cooldown';
  if (ctx.state.accepted.length >= ctx.rules.maxPerWindow) return 'chain-throttled';
  return null;
};

const rollChain = ({ random }, chance) => {
  const roll = random();
  return { reply: roll <= chance, reason: roll <= chance ? 'chain-accepted' : 'chain-roll', chance, roll };
};

const decide = (ctx, { botTurns, userId }) => {
  if (ctx.state.busy) return { reply: false, reason: 'chain-busy' };
  const limited = limitReason(ctx, userId);
  if (limited) return { reply: false, reason: limited };
  if (botTurns >= ctx.rules.maxBotTurns) return { reply: false, reason: 'chain-limit' };
  const chance = chanceFor(ctx.rules, botTurns);
  if (chance >= 1) return { reply: true, reason: 'chain-guaranteed', chance };
  return rollChain(ctx, chance);
};

// Recorded on begin, so a refused or failed decision never uses up the allowance.
const begin = ({ state, now }, { userId }) => {
  state.busy = true;
  state.lastByUser.set(userId, now());
  state.accepted.push(now());
};

export const createChainPolicy = ({ config, random, now }) => {
  const ctx = {
    rules: config.chain, random, now, state: { busy: false, lastByUser: new Map(), accepted: [] },
  };
  return {
    decide: (options) => decide(ctx, options),
    begin: (options) => begin(ctx, options),
    end: () => {
      ctx.state.busy = false;
    },
  };
};
