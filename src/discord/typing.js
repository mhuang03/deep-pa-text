// Keeps the "typing..." indicator alive while the bot works. Discord clears it whenever the bot
// sends a message and otherwise after about ten seconds, hence the refresh and the pulse.
export const startTyping = (channel, { clock, refreshMs, logger }) => {
  let warned = false;
  let stopped = false;

  const send = async () => {
    try {
      await channel.sendTyping();
    } catch (error) {
      if (warned) return;
      warned = true;
      logger.warn('Could not send the typing indicator:', error);
    }
  };

  const pulse = () => {
    if (stopped) return;
    void send();
  };

  pulse();
  const handle = clock.setInterval(pulse, refreshMs);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clock.clearInterval(handle);
  };

  return { pulse, stop };
};
