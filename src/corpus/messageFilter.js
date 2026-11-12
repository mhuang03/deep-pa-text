import { createTransformers } from './transformers.js';
import { APPROVED_AUTHORS, MIN_LENGTH, createPredicates } from './predicates.js';

export const createMessageFilter = ({ users, pingCache, config }) => {
  const usernames = new Set(users.map((user) => user.username));
  const transformers = createTransformers({ pingCache });
  const predicates = createPredicates({ usernames, config });
  const anyAuthorPredicates = predicates.filter((p) => p.name !== APPROVED_AUTHORS);
  const chainPredicates = anyAuthorPredicates.filter((p) => p.name !== MIN_LENGTH);

  const transform = (content) =>
    transformers.reduce((text, transformer) => transformer.apply(text), content || '');

  const run = (record, active) => {
    const transformed = { ...record, content: transform(record.content) };
    return active.every((predicate) => predicate.test(transformed)) ? transformed : null;
  };

  return {
    transform,
    filter: (record) => run(record, predicates),
    filterAnyAuthor: (record) => run(record, anyAuthorPredicates),
    filterForChain: (record) => run(record, chainPredicates),
  };
};
