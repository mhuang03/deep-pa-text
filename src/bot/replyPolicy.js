export const createReplyPolicy = ({ config, now, random }) => {
  const {
    probability, minIntervalMs, escalateAfterMisses, escalationStep, override, failureCooldownMs,
  } = config.reply;
  let replyTime = null;
  let misses = 0;
  let inFlight = 0;
  let cooldownUntil = 0;

  // Each claim frees only itself, once, so an override claim and a normal claim never clear each other.
  const claim = () => {
    let held = true;
    inFlight += 1;
    return () => {
      if (!held) return;
      held = false;
      inFlight -= 1;
    };
  };

  const isRateLimited = () => replyTime !== null && now() - replyTime < minIntervalMs;

  const roll = () => {
    const value = random();
    const chance = probability + Math.max(0, misses - escalateAfterMisses) * escalationStep;
    if (value > chance) {
      misses++;
      return { reply: false, reason: 'random', roll: value, chance };
    }
    return { reply: true, reason: 'accepted', roll: value, chance, release: claim() };
  };

  const decide = () => {
    if (override) return { reply: true, reason: 'override', release: claim() };
    if (isRateLimited()) return { reply: false, reason: 'rate-limited' };
    if (inFlight > 0) return { reply: false, reason: 'in-flight' };
    if (now() < cooldownUntil) return { reply: false, reason: 'cooldown' };
    return roll();
  };

  const noteReply = ({ resetMisses }) => {
    replyTime = now();
    if (resetMisses) misses = 0;
  };

  // A failure before anything was delivered must not let every message start its own attempt.
  const noteFailure = () => {
    cooldownUntil = now() + failureCooldownMs;
  };

  // Monotonic and never in the future, so a restore cannot lengthen or invent a rate-limit window.
  const restore = ({ replyTime: restored }) => {
    if (restored === null || restored === undefined) return;
    const clamped = Math.min(restored, now());
    if (replyTime === null || clamped > replyTime) replyTime = clamped;
  };

  return { decide, noteReply, noteFailure, restore };
};
