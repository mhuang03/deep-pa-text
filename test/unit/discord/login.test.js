import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { loginAndWait } from '../../../src/discord/login.js';

const fakeClient = ({ loginError = null } = {}) => {
  const handlers = new Map();
  const events = [];
  return {
    events,
    once: (event, handler) => handlers.set(event, handler),
    login: async (token) => {
      events.push(['login', token]);
      if (loginError) throw loginError;
      setImmediate(() => handlers.get(Events.ClientReady)?.());
    },
    on: () => { throw new Error('login must not register handlers'); },
  };
};

test('resolves once the client reports ready, after logging in with the token', async () => {
  const client = fakeClient();
  await loginAndWait(client, 'secret-token');
  assert.deepEqual(client.events, [['login', 'secret-token']]);
});

test('waits for the ready event rather than the end of login', async () => {
  const client = fakeClient();
  let settled = false;
  client.login = async () => {};
  const pending = loginAndWait(client, 't').then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(typeof pending.then, 'function');
});

test('rejects when the login fails', async () => {
  const client = fakeClient({ loginError: new Error('An invalid token was provided') });
  await assert.rejects(loginAndWait(client, 'bad'), /invalid token/);
});
