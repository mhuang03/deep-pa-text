export const createReplyPolicy = ({ config, now, random }) => {
  const { probability, minIntervalMs, escalateAfterMisses, escalationStep, override } = config.reply;
  let replyTime = null;
  let misses = 0;

  const isRateLimited = () => replyTime !== null && now() - replyTime < minIntervalMs;

  const roll = () => {
    const value = random();
    const chance = probability + Math.max(0, misses - escalateAfterMisses) * escalationStep;
    if (value > chance) {
      misses++;
      return { reply: false, reason: 'random', roll: value, chance };
    }
    return { reply: true, reason: 'accepted', roll: value, chance };
  };

  const decide = () => {
    if (override) return { reply: true, reason: 'override' };
    if (isRateLimited()) return { reply: false, reason: 'rate-limited' };
    return roll();
  };

  const noteReply = ({ resetMisses }) => {
    replyTime = now();
    if (resetMisses) misses = 0;
  };

  // Monotonic and never in the future, so a restore cannot lengthen or invent a rate-limit window.
  const restore = ({ replyTime: restored }) => {
    if (restored === null || restored === undefined) return;
    const clamped = Math.min(restored, now());
    if (replyTime === null || clamped > replyTime) replyTime = clamped;
  };

  return { decide, noteReply, restore };
};
