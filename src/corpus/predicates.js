export const APPROVED_AUTHORS = 'approvedAuthors';

export const createPredicates = ({ usernames, config }) => {
  const { minLength, maxLength, commandPrefixes } = config.filter;
  return [
    { name: APPROVED_AUTHORS, test: (m) => usernames.has(m.author) },
    { name: 'hasContent', test: (m) => Boolean(m.content) },
    { name: 'minLength', test: (m) => m.content.length >= minLength },
    { name: 'maxLength', test: (m) => m.content.length <= maxLength },
    { name: 'noCommands', test: (m) => commandPrefixes.every((p) => !m.content.startsWith(p)) },
    {
      name: 'noConnections',
      test: (m) => !m.content.includes('Connections') && !m.content.includes('Puzzle #'),
    },
    { name: 'noWordles', test: (m) => !/Wordle \d+ \d\/\d/.test(m.content) },
    { name: 'noStrands', test: (m) => !/Strands #\d+/.test(m.content) },
  ];
};
