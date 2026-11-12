import { Events } from 'discord.js';

// Logs in without registering any handler, so the caller can never reply to anything.
export const loginAndWait = async (client, token) => {
  const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
  await client.login(token);
  await ready;
};
