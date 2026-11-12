export const DELIVERY_STAGE = 'delivery';
export const GENERATION_STAGE = 'generation';

// Lets handlers tell a send failure (arm the rate limit) from a generation failure, and say whose work failed.
// The caught error is wrapped, never mutated.
export const tagFailure = (error, { stage, persona, trigger }) => {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message, { cause: error }), { stage, persona, trigger });
};
