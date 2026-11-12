import { Events } from 'discord.js';

export const createBot = ({ client, config, handlers, clock, logger }) => {
  const revivePeriod = () =>
    config.revive.override ? config.revive.overrideCheckIntervalMs : config.revive.checkIntervalMs;

  const onReady = () => {
    logger.info(`Logged in as ${client.user.tag}`);
    clock.setInterval(handlers.reviveTick, revivePeriod());
  };

  const start = async () => {
    client.once(Events.ClientReady, onReady);
    client.on(Events.MessageCreate, handlers.messageCreate);
    client.on(Events.InteractionCreate, handlers.replyCommand);
    await client.login(config.discord.token);
  };

  return { start };
};
