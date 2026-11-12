import { Events } from 'discord.js';
import { registerGatewayEvents } from './gatewayEvents.js';
import { createReady } from './ready.js';

export const createBot = ({ client, config, handlers, lifecycle, startupTasks, logger }) => {
  const { track } = lifecycle;
  const { onReady } = createReady({ client, config, handlers, lifecycle, startupTasks, logger });

  const start = async () => {
    registerGatewayEvents({ client, lifecycle, logger });
    client.once(Events.ClientReady, onReady);
    client.on(Events.MessageCreate, track(handlers.messageCreate, 'messageCreate'));
    client.on(Events.InteractionCreate, track(handlers.replyCommand, 'replyCommand'));
    client.on(Events.MessageDelete, track(handlers.messageDelete, 'messageDelete'));
    client.on(Events.MessageBulkDelete, track(handlers.messageBulkDelete, 'messageBulkDelete'));
    client.on(Events.MessageUpdate, track(handlers.messageUpdate, 'messageUpdate'));
    await client.login(config.discord.token);
  };

  return { start };
};
