export const createLogger = (sink = console) => ({
  info: (...args) => sink.log(...args),
  warn: (...args) => sink.warn(...args),
  error: (...args) => sink.error(...args),
});

export const formatTimestamp = (ms, { locale, timeZone }) =>
  new Date(ms).toLocaleString(locale, { timeZone });
