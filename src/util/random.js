// Every roll comes from an injected `random` (or a roll already drawn), so tests can script them.

// An integer in [min, max], one roll.
export const randomInt = (random, min, max) => min + Math.floor(random() * (max - min + 1));

// A uniform pick from a non-empty list; a roll of exactly 1 still lands on the last entry.
export const pickUniform = (list, roll) => list[Math.min(list.length - 1, Math.floor(roll * list.length))];
