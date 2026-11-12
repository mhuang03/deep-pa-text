export const createActivityTracker = ({ now }) => {
  let lastMessageTime = now();
  let lastWasBot = true;
  // The initial state is a guess, so only a live event makes a restore monotonic.
  let live = false;
  // Counts every change, so an undo can tell whether anything else touched the tracker since.
  let version = 0;

  const apply = (state, isLive) => {
    lastMessageTime = state.lastMessageTime;
    lastWasBot = state.lastWasBot;
    live = isLive;
    version += 1;
  };

  // A restore never moves the clock backwards once a live handler has spoken.
  const restore = (state) => {
    if (live && state.lastMessageTime <= lastMessageTime) return;
    apply(state, live);
  };

  const noteBot = () => {
    const before = { lastMessageTime, lastWasBot };
    const wasLive = live;
    apply({ lastMessageTime: now(), lastWasBot: true }, true);
    const claimed = version;
    // A human message that arrived meanwhile keeps its timestamp: the undo then does nothing.
    return () => {
      if (version === claimed) apply(before, wasLive);
    };
  };

  return {
    noteHuman: ({ timestamp }) => apply({ lastMessageTime: timestamp, lastWasBot: false }, true),
    noteBot,
    restore,
    get: () => ({ lastMessageTime, lastWasBot }),
  };
};
