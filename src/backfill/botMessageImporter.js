import { readPersonaFromEmbeds } from '../discord/botPersona.js';
import { REPLY_LINK_PREFIX } from '../discord/webhookDelivery.js';
import { TRIGGERS } from '../bot/triggers.js';
import { truncateCodePoints } from '../util/text.js';

// Webhook delivery puts a link to the replied-to message on the first line.
export const splitReplyLink = (message) => {
  const { content } = message;
  if (!content.startsWith(REPLY_LINK_PREFIX)) return { text: content, reference: message.reference?.messageId ?? null };
  const newline = content.indexOf('\n');
  const line = newline === -1 ? content : content.slice(0, newline);
  const text = newline === -1 ? '' : content.slice(newline + 1);
  const segment = line.slice(REPLY_LINK_PREFIX.length).trim().split('/').at(-1);
  return { text, reference: segment || null };
};

export const createBotMessageImporter = ({ botMessageStore, profileStore, userDirectory, config, logger }) => {
  const { webhookUsernameMax } = config.discord;

  const namesOfUser = ({ username }) =>
    [username, ...profileStore.namesOf(username)].map((name) => truncateCodePoints(name, webhookUsernameMax));

  // Display names are not unique, so an ambiguous name is never guessed.
  const personaFromWebhookName = (message) => {
    if (!message.webhookId) return null;
    const matches = userDirectory.users.filter((user) => namesOfUser(user).includes(message.author.username));
    return matches.length === 1 ? matches[0].username : null;
  };

  const findPersona = (message, known) =>
    known?.persona ?? readPersonaFromEmbeds(message, userDirectory) ?? personaFromWebhookName(message);

  const buildRow = (message, known, persona) => {
    const { text, reference } = splitReplyLink(message);
    const content = known?.content ?? text;
    if (!content) return null;
    return {
      id: message.id,
      persona,
      content,
      timestamp: message.createdTimestamp,
      reference: known?.reference ?? reference,
      trigger: known?.trigger ?? TRIGGERS.IMPORTED,
    };
  };

  const run = (ownBot, { lookup = () => null, dryRun = false } = {}) => {
    const counts = { imported: 0, alreadyStored: 0, unattributed: 0, skippedEmpty: 0 };
    ownBot.forEach((message) => {
      if (botMessageStore.getById(message.id)) {
        counts.alreadyStored += 1;
        return;
      }
      const known = lookup(message.id);
      const persona = findPersona(message, known);
      if (!persona) {
        counts.unattributed += 1;
        logger.info(`Bot message ${message.id} has no attributable persona; skipped.`);
        return;
      }
      const row = buildRow(message, known, persona);
      if (!row) {
        counts.skippedEmpty += 1;
        return;
      }
      if (!dryRun) botMessageStore.insert(row);
      counts.imported += 1;
    });
    return counts;
  };

  return { run };
};
