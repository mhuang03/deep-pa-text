import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { REPLY_COMMAND_NAME, buildCommands } from '../../../src/discord/commands.js';

test('registers exactly one message context-menu command named reply', () => {
  const commands = buildCommands();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'reply');
  assert.equal(commands[0].type, ApplicationCommandType.Message);
  assert.equal(REPLY_COMMAND_NAME, 'reply');
});

test('equals the JSON the legacy register script built', () => {
  const legacy = new ContextMenuCommandBuilder().setName('reply').setType(ApplicationCommandType.Message);
  assert.deepEqual(buildCommands(), [legacy.toJSON()]);
});

test('returns fresh objects each call', () => {
  assert.notEqual(buildCommands(), buildCommands());
});
