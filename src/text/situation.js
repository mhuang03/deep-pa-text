const ONE_HOUR_MS = 3600000;
const TWO_DAYS_MS = 172800000;
const MS_PER_DAY = 86400000;

export const describeLocalTime = (nowMs, timeZone) => {
  const parts = (options) => new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(nowMs);
  const weekday = parts({ weekday: 'long' });
  const time = parts({ hour: 'numeric', minute: '2-digit', hour12: true });
  return `${weekday} ${time}`;
};

const describeHours = (quietMs) => {
  const hours = Math.max(1, Math.round(quietMs / ONE_HOUR_MS));
  return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
};

export const describeQuiet = (quietMs) => {
  if (quietMs === null || quietMs === undefined) return null;
  const ms = Math.max(0, quietMs);
  if (ms < ONE_HOUR_MS) return 'less than an hour';
  if (ms < TWO_DAYS_MS) return describeHours(ms);
  return `about ${Math.round(ms / MS_PER_DAY)} days`;
};
