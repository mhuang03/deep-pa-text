import { loadEnvFile } from 'node:process';
import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { buildCommands } from '../src/discord/commands.js';

loadEnvFile('.env');
const { discord } = loadConfig(process.env);
const rest = new REST({ version: '10' }).setToken(discord.token);

try {
  console.log('Started refreshing application commands.');
  await rest.put(
    Routes.applicationGuildCommands(discord.clientId, discord.guildId),
    { body: buildCommands() },
  );
  console.log('Successfully reloaded application commands.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
