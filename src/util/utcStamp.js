// A UTC time as YYYYMMDDHHMMSS, for ids that sort by time.
export const utcStamp = (ms) => new Date(ms).toISOString().replace(/\D/g, '').slice(0, 14);
