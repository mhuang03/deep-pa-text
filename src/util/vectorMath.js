// Row helpers over flat Float32Arrays of `count x dimensions` numbers.

// A closure keeps the hot loop at two arguments: the dot product of row i of `left` and row j of `right`.
export const createRowDot = (left, right, dimensions) => (leftRow, rightRow) => {
  const a = leftRow * dimensions;
  const b = rightRow * dimensions;
  let sum = 0;
  for (let i = 0; i < dimensions; i += 1) sum += left[a + i] * right[b + i];
  return sum;
};

// Scales one row to unit length in place; false (and untouched) for a zero row.
export const normaliseRow = (vector, offset, dimensions) => {
  let squares = 0;
  for (let i = 0; i < dimensions; i += 1) squares += vector[offset + i] ** 2;
  const length = Math.sqrt(squares);
  if (!(length > 0)) return false;
  for (let i = 0; i < dimensions; i += 1) vector[offset + i] /= length;
  return true;
};
