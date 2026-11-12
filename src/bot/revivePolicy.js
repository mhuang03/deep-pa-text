export const isDaytime = (nowMs, config) => {
  const { timeZone, dayStartHour, dayEndHour } = config.revive;
  const text = new Date(nowMs).toLocaleString('en-US', { timeZone, hour: 'numeric', hour12: false });
  const hour = parseInt(text);
  return hour >= dayStartHour && hour <= dayEndHour;
};

const exceedsIdleLimit = (elapsed, nowMs, config) => {
  const { dayIdleMs, nightIdleMs } = config.revive;
  return elapsed > (isDaytime(nowMs, config) ? dayIdleMs : nightIdleMs);
};

export const shouldRevive = ({ activity, nowMs, config }) => {
  if (config.revive.override) return true;
  if (activity.lastWasBot) return false;
  return exceedsIdleLimit(nowMs - activity.lastMessageTime, nowMs, config);
};
