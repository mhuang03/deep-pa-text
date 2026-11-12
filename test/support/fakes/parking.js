// Lets any fake mark the handler run that is awaiting it as parked, so `settle` does not wait on it.
import { AsyncLocalStorage } from 'node:async_hooks';

const current = new AsyncLocalStorage();

export const runInEntry = (entry, fn) => current.run(entry, fn);

export const parkWhile = async (fn) => {
  const entry = current.getStore();
  if (entry) entry.parked = true;
  try {
    return await fn();
  } finally {
    if (entry) entry.parked = false;
  }
};
