// Lets the backfill script tell a Chroma failure (repairable with --sync-vectors) from any other.
export const markVectorError = (error) => Object.assign(error, { isVectorError: true });
