// Lets callers tell a Chroma or embedding failure (repairable by the vector sync) from any other.
// Returns a new error so the original, which may be shared, is never mutated.
export const markVectorError = (error) => {
  if (error?.isVectorError === true) return error;
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message, { cause: error }), { isVectorError: true });
};
