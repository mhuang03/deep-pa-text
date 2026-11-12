export const COMMAND_COOLDOWN_MESSAGE = 'You are using this too quickly. Try again in a moment.';
export const COMMAND_BUSY_MESSAGE = 'The bot is busy with other replies. Try again in a moment.';

export const COMMAND_REFUSALS = Object.freeze({
  cooldown: COMMAND_COOLDOWN_MESSAGE,
  busy: COMMAND_BUSY_MESSAGE,
});

const ALLOWED = Object.freeze({ allowed: true });

// Bounds command replies per user and in total; each one costs an LLM call and an embedding.
export const createCommandLimiter = ({ config, now }) => {
  const { userCooldownMs, maxConcurrent } = config.command;
  const startedBy = new Map();
  let active = 0;

  // Entries older than the cooldown can never block again.
  const prune = () => {
    const current = now();
    [...startedBy].forEach(([userId, at]) => {
      if (current - at >= userCooldownMs) startedBy.delete(userId);
    });
  };

  const check = (userId) => {
    prune();
    if (startedBy.has(userId)) return { allowed: false, reason: 'cooldown' };
    if (active >= maxConcurrent) return { allowed: false, reason: 'busy' };
    return ALLOWED;
  };

  // Re-checks and claims in one step, so two submissions cannot both pass the courtesy check.
  const begin = (userId) => {
    const verdict = check(userId);
    if (!verdict.allowed) return verdict;
    startedBy.set(userId, now());
    active += 1;
    return ALLOWED;
  };

  const end = () => {
    active = Math.max(0, active - 1);
  };

  return { check, begin, end };
};
