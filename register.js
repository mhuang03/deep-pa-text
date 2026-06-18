import { loadEnvFile } from 'node:process';
loadEnvFile('.env');

import { REST, Routes, ContextMenuCommandBuilder, ApplicationCommandType } from 'discord.js';

const GUILD_ID = '478743674826784769';

const replyCommand = new ContextMenuCommandBuilder()
  .setName('reply')
  .setType(ApplicationCommandType.Message);
  
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

try {
  console.log('Started refreshing application commands.');

  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, GUILD_ID),
    { 
      body: [
        replyCommand.toJSON(),
      ] 
    },
  );

  console.log('Successfully reloaded application commands.');
} catch (error) {
  console.error(error);
}