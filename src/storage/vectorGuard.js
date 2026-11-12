import { withTimeout } from '../util/withTimeout.js';
import { markVectorError } from '../util/vectorError.js';

// Bounds every Chroma and embedding call and tags what leaves the vector store as a vector error.
// A timeout abandons the request without cancelling it: the call finishes in the background.
export const createVectorGuard = ({ config, clock }) => {
  const { timeoutMs, connectTimeoutMs, batchTimeoutMs } = config.chroma;

  const bounded = (method, ms, work) => withTimeout((async () => work())(), {
    ms,
    label: `chroma ${method}`,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  // Every failure of the call, a timeout included, leaves as a tagged copy of the original error.
  const timed = async (method, ms, work) => {
    try {
      return await bounded(method, ms, work);
    } catch (error) {
      throw markVectorError(error);
    }
  };

  return { timed, limits: { interactive: timeoutMs, connect: connectTimeoutMs, batch: batchTimeoutMs } };
};
