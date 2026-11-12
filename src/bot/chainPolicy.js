export const createChainPolicy = ({ config, random }) => {
  const { enabled, fullDepth, decay, maxBotTurns } = config.chain;
  let busy = false;

  const chanceFor = (botTurns) =>
    (botTurns <= fullDepth ? 1 : decay ** (botTurns - fullDepth));

  const decide = ({ botTurns }) => {
    if (!enabled) return { reply: false, reason: 'chain-disabled' };
    if (busy) return { reply: false, reason: 'chain-busy' };
    if (botTurns >= maxBotTurns) return { reply: false, reason: 'chain-limit' };
    const chance = chanceFor(botTurns);
    if (chance >= 1) return { reply: true, reason: 'chain-guaranteed', chance };
    const roll = random();
    return { reply: roll <= chance, reason: roll <= chance ? 'chain-accepted' : 'chain-roll', chance, roll };
  };

  return {
    decide,
    begin: () => {
      busy = true;
    },
    end: () => {
      busy = false;
    },
  };
};
