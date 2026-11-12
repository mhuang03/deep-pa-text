import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';

export const REPLY_COMMAND_NAME = 'reply';

export const buildCommands = () => [
  new ContextMenuCommandBuilder()
    .setName(REPLY_COMMAND_NAME)
    .setType(ApplicationCommandType.Message)
    .toJSON(),
];
