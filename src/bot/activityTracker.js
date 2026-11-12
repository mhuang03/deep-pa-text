export const createActivityTracker = ({ now }) => {
  let lastMessageTime = now();
  let lastWasBot = true;

  return {
    noteHuman: ({ timestamp }) => {
      lastMessageTime = timestamp;
      lastWasBot = false;
    },
    noteBot: () => {
      lastMessageTime = now();
      lastWasBot = true;
    },
    get: () => ({ lastMessageTime, lastWasBot }),
  };
};
