import { TRIGGERS } from '../../util/triggers.js';

const DISABLED = Object.freeze({ start: false, reason: 'disabled' });

// The interval is measured from the newest visible conversation turn, so it survives restarts.
const isTooSoon = ({ botMessageStore, now, settings }) => {
  const last = botMessageStore.newest({ triggers: [TRIGGERS.CONVERSATION] });
  return last !== null && now() - last.timestamp < settings.minIntervalMs;
};

const decide = (ctx) => {
  const { settings, random } = ctx;
  if (!settings.enabled || !(settings.chance > 0)) return DISABLED;
  if (isTooSoon(ctx)) return { start: false, reason: 'too-soon' };
  const roll = random();
  return roll < settings.chance ? { start: true, roll } : { start: false, reason: 'roll', roll };
};

// Asked once per due revive; a `start: false` leaves the normal revive untouched.
export const createConversationPolicy = ({ botMessageStore, random, now, config }) => {
  const ctx = { botMessageStore, random, now, settings: config.conversation };
  return { decide: () => decide(ctx) };
};
