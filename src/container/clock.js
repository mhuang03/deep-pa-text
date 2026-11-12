// Lazy wrappers: global mocks of Date, Math.random and setInterval are honoured at call time.
export const defaultClock = () => {
  const clock = {
    now: () => Date.now(),
    random: () => Math.random(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    clearInterval: (handle) => clearInterval(handle),
    sleep: (ms) => new Promise((resolve) => { clock.setTimeout(resolve, ms); }),
  };
  return clock;
};
