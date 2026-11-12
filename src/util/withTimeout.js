// Does not cancel the underlying work: an abandoned promise finishes in the background.
export const withTimeout = (promise, { ms, label, setTimeout, clearTimeout }) =>
  new Promise((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    const settle = (settler) => (value) => {
      clearTimeout(handle);
      settler(value);
    };
    promise.then(settle(resolve), settle(reject));
  });
