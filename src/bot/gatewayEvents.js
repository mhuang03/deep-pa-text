import { Events } from 'discord.js';

const GENERIC_HINT = 'The gateway closed the connection and will not reconnect.';

// discord.js emits ShardDisconnect only for close codes it will not recover from.
export const CLOSE_HINTS = Object.freeze({
  4004: 'Authentication failed: check DISCORD_BOT_TOKEN.',
  4010: 'Invalid shard.',
  4011: 'Sharding is required.',
  4012: 'Invalid gateway API version.',
  4013: 'Invalid intents.',
  4014: 'Disallowed intents: enable the Message Content intent in the Discord developer portal.',
});

export const registerGatewayEvents = ({ client, lifecycle, logger }) => {
  client.on(Events.Error, (error) => logger.error('Discord client error:', error));
  client.on(Events.Warn, (message) => logger.warn(`Discord client warning: ${message}`));
  client.on(Events.ShardError, (error, shardId) => logger.error(`Discord shard ${shardId} error:`, error));
  client.on(Events.ShardReconnecting, (shardId) => logger.info(`Discord shard ${shardId} is reconnecting.`));
  client.on(Events.ShardResume, (shardId) => logger.info(`Discord shard ${shardId} resumed.`));
  client.on(Events.ShardDisconnect, async (closeEvent, shardId) => {
    const code = closeEvent?.code;
    const hint = CLOSE_HINTS[code] ?? GENERIC_HINT;
    logger.error(`Discord shard ${shardId} disconnected with close code ${code}. ${hint}`);
    await lifecycle.shutdown({ reason: `gateway closed with code ${code}`, code: 1 });
  });
};
