const roleOf = (turn) => (turn.isPersona ? 'assistant' : 'user');

const contentOf = (turn) => (turn.isPersona ? turn.content : `${turn.speaker}: ${turn.content}`);

const toMessage = (turn) => ({ role: roleOf(turn), content: contentOf(turn) });

// Providers reject consecutive same-role messages, so neighbours are joined by a blank line.
const mergeNeighbours = (messages) => messages.reduce((merged, message) => {
  const last = merged.at(-1);
  if (last && last.role === message.role) {
    return [...merged.slice(0, -1), { ...last, content: `${last.content}\n\n${message.content}` }];
  }
  return [...merged, message];
}, []);

export const buildChatMessages = ({ system, user, turns = [] }) =>
  mergeNeighbours([
    { role: 'system', content: system },
    { role: 'user', content: user },
    ...turns.map(toMessage),
  ]);
