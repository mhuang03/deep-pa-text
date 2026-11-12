export const createActivityTracker = ({ now }) => {
  let lastMessageTime = now();
  let lastWasBot = true;
  // The initial state is a guess, so only a live event makes a restore monotonic.
  let live = false;

  // A restore never moves the clock backwards once a live handler has spoken.
  const restore = (state) => {
    if (live && state.lastMessageTime <= lastMessageTime) return;
    lastMessageTime = state.lastMessageTime;
    lastWasBot = state.lastWasBot;
  };

  return {
    noteHuman: ({ timestamp }) => {
      lastMessageTime = timestamp;
      lastWasBot = false;
      live = true;
    },
    noteBot: () => {
      lastMessageTime = now();
      lastWasBot = true;
      live = true;
    },
    restore,
    get: () => ({ lastMessageTime, lastWasBot }),
  };
};
