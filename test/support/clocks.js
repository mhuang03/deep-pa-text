// Timers that never fire: enough for code that sets a timeout and clears it when its work settles.
export const inertClock = () => ({
  now: () => 0,
  setTimeout: () => 0,
  clearTimeout: () => {},
});

// Chroma settings for stores built directly in unit tests.
export const CHROMA_LIMITS = { timeoutMs: 30000, connectTimeoutMs: 10000, batchTimeoutMs: 120000 };

// Timers fired by hand: `fireNext()` runs the oldest pending one, `scheduled` lists the delays asked for.
export const createManualClock = () => {
  const pending = new Map();
  const scheduled = [];
  let nextHandle = 1;
  return {
    now: () => 0,
    scheduled,
    setTimeout: (fn, ms) => {
      const handle = nextHandle++;
      scheduled.push(ms);
      pending.set(handle, fn);
      return handle;
    },
    clearTimeout: (handle) => pending.delete(handle),
    pendingCount: () => pending.size,
    fireNext: () => {
      const [handle, fn] = pending.entries().next().value;
      pending.delete(handle);
      fn();
    },
  };
};

// Lets queued promise callbacks run so a hung call has reached its timer before the test fires it.
export const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
