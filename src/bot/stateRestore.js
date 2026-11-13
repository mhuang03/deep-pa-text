import { TRIGGERS } from '../util/triggers.js';

const NATURAL = [TRIGGERS.AUTO, TRIGGERS.REVIVE, TRIGGERS.CONVERSATION];
const REPLIES = [TRIGGERS.AUTO, TRIGGERS.CHAIN, TRIGGERS.COMMAND, TRIGGERS.CONVERSATION];

const buildActivity = ({ lastHuman, lastNatural }) => {
  if (lastNatural && lastNatural.timestamp > lastHuman.timestamp) {
    return { lastMessageTime: lastNatural.timestamp, lastWasBot: true };
  }
  return { lastMessageTime: lastHuman.timestamp, lastWasBot: false };
};

// With a capped catch-up the stored newest message is not the channel's newest, so activity restarts fresh.
const restoreActivity = ({ messageStore, botMessageStore, activity, now, capped }) => {
  if (capped) {
    activity.restore({ lastMessageTime: now(), lastWasBot: true });
    return;
  }
  const lastHuman = messageStore.newestRaw();
  if (!lastHuman) return;
  activity.restore(buildActivity({ lastHuman, lastNatural: botMessageStore.newest({ triggers: NATURAL }) }));
};

export const restoreState = (deps) => {
  const { botMessageStore, replyPolicy, capped = false } = deps;
  restoreActivity({ ...deps, capped });
  const lastReply = botMessageStore.newest({ triggers: REPLIES });
  replyPolicy.restore({ replyTime: lastReply?.timestamp ?? null });
};
