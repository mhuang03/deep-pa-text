import { Events } from 'discord.js';

export const createBot = ({ client, config, handlers, clock, logger }) => {
  const revivePeriod = () =>
    config.revive.override ? config.revive.overrideCheckIntervalMs : config.revive.checkIntervalMs;

  // The first refresh is not awaited: it must not delay ready. The handler catches its own errors.
  const startProfileRefresh = () => {
    const period = config.profiles.refreshIntervalMs;
    if (period === 0) return;
    handlers.profileRefresh();
    clock.setInterval(handlers.profileRefresh, period);
  };

  const onReady = () => {
    logger.info(`Logged in as ${client.user.tag}`);
    clock.setInterval(handlers.reviveTick, revivePeriod());
    startProfileRefresh();
  };

  const start = async () => {
    client.once(Events.ClientReady, onReady);
    client.on(Events.MessageCreate, handlers.messageCreate);
    client.on(Events.InteractionCreate, handlers.replyCommand);
    await client.login(config.discord.token);
  };

  return { start };
};
