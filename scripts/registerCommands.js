import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { loadEnvIfPresent } from '../src/config/env.js';
import { assertRequired } from '../src/config/requirements.js';
import { isConfigError } from '../src/config/errors.js';
import { createLogger } from '../src/logger.js';
import { secretsOf } from '../src/config/secrets.js';
import { buildCommands } from '../src/discord/commands.js';

let logger = createLogger(console);

try {
  loadEnvIfPresent();
  const config = loadConfig(process.env);
  assertRequired(config, process.env, 'register');
  logger = createLogger(console, { secrets: secretsOf(config) });
  const { discord } = config;
  const rest = new REST({ version: '10' }).setToken(discord.token);
  console.log('Started refreshing application commands.');
  await rest.put(
    Routes.applicationGuildCommands(discord.clientId, discord.guildId),
    { body: buildCommands() },
  );
  console.log('Successfully reloaded application commands.');
} catch (error) {
  if (isConfigError(error)) logger.error(error.message);
  else logger.error(error);
  process.exitCode = 1;
}
