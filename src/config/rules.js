import { createConfigError } from './errors.js';

// Each rule pairs a predicate with the wording used in the error message.
export const integer = (min, max = Infinity) => ({
  test: (v) => Number.isInteger(v) && v >= min && v <= max,
  text: max === Infinity ? `an integer of at least ${min}` : `an integer from ${min} to ${max}`,
});

export const atLeast = (min) => ({
  test: (v) => Number.isFinite(v) && v >= min,
  text: `a number of at least ${min}`,
});

export const above = (min) => ({
  test: (v) => Number.isFinite(v) && v > min,
  text: `a number greater than ${min}`,
});

// A number in an interval; `open` names which ends are excluded ('low', 'high', 'both' or 'none').
export const between = (low, high, open = 'none') => {
  const lowOpen = open === 'low' || open === 'both';
  const highOpen = open === 'high' || open === 'both';
  return {
    test: (v) => Number.isFinite(v) && (lowOpen ? v > low : v >= low) && (highOpen ? v < high : v <= high),
    text: `a number in ${lowOpen ? '(' : '['}${low}, ${high}${highOpen ? ')' : ']'}`,
  };
};

export const checkRules = (name, section, rules) => {
  Object.entries(rules).forEach(([key, rule]) => {
    if (!rule.test(section[key])) throw createConfigError(`${name}.${key} must be ${rule.text}`);
  });
  return section;
};
