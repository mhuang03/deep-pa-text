// Each claim frees only itself, once, so an override claim and a normal claim never clear each other.
const claim = (state) => {
  let held = true;
  state.inFlight += 1;
  return () => {
    if (!held) return;
    held = false;
    state.inFlight -= 1;
  };
};

const isRateLimited = ({ rules, state, now }) =>
  state.replyTime !== null && now() - state.replyTime < rules.minIntervalMs;

const roll = ({ rules, state, random }) => {
  const value = random();
  const chance = rules.probability + Math.max(0, state.misses - rules.escalateAfterMisses) * rules.escalationStep;
  if (value > chance) {
    state.misses += 1;
    return { reply: false, reason: 'random', roll: value, chance };
  }
  return { reply: true, reason: 'accepted', roll: value, chance, release: claim(state) };
};

const decide = (ctx) => {
  const { rules, state, now } = ctx;
  if (rules.override) return { reply: true, reason: 'override', release: claim(state) };
  if (isRateLimited(ctx)) return { reply: false, reason: 'rate-limited' };
  if (state.inFlight > 0) return { reply: false, reason: 'in-flight' };
  if (now() < state.cooldownUntil) return { reply: false, reason: 'cooldown' };
  return roll(ctx);
};

// Monotonic and never in the future, so a restore cannot lengthen or invent a rate-limit window.
const restore = ({ state, now }, restored) => {
  if (restored === null || restored === undefined) return;
  const clamped = Math.min(restored, now());
  if (state.replyTime === null || clamped > state.replyTime) state.replyTime = clamped;
};

export const createReplyPolicy = ({ config, now, random }) => {
  const ctx = {
    rules: config.reply, now, random, state: { replyTime: null, misses: 0, inFlight: 0, cooldownUntil: 0 },
  };
  return {
    decide: () => decide(ctx),
    // A public hold on the in-flight counter: while held, decide() starts no auto reply. Idempotent release.
    claim: () => claim(ctx.state),
    noteReply: ({ resetMisses }) => {
      ctx.state.replyTime = now();
      if (resetMisses) ctx.state.misses = 0;
    },
    // A failure before anything was delivered must not let every message start its own attempt.
    noteFailure: () => {
      ctx.state.cooldownUntil = now() + ctx.rules.failureCooldownMs;
    },
    restore: ({ replyTime }) => restore(ctx, replyTime),
  };
};
