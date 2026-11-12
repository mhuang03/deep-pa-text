import { readPersonaFromEmbeds } from '../discord/botPersona.js';
import { REPLY_LINK_PREFIX } from '../discord/webhookDelivery.js';
import { TRIGGERS } from '../bot/triggers.js';
import { truncateCodePoints } from '../text/truncate.js';

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

const UNATTRIBUTED_SAMPLE = 5;

const namesOfUser = ({ profileStore, config }, { username }) =>
  [username, ...profileStore.namesOf(username)].map((name) => truncateCodePoints(name, config.discord.webhookUsernameMax));

// Display names are not unique, so an ambiguous name is never guessed.
const personaFromWebhookName = (ctx, message) => {
  if (!message.webhookId) return null;
  const matches = ctx.userDirectory.users.filter((user) => namesOfUser(ctx, user).includes(message.author.username));
  return matches.length === 1 ? matches[0].username : null;
};

const findPersona = (ctx, message, known) =>
  known?.persona ?? readPersonaFromEmbeds(message, ctx.userDirectory) ?? personaFromWebhookName(ctx, message);

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

// One line for the whole run: a large history can hold thousands of these.
const reportUnattributed = ({ logger }, ids) => {
  if (ids.length === 0) return;
  const sample = ids.slice(0, UNATTRIBUTED_SAMPLE).join(', ');
  logger.info(`${ids.length} bot messages have no attributable persona and were skipped; first ids: ${sample}.`);
};

const examine = (ctx, message, lookup) => {
  if (ctx.botMessageStore.getById(message.id)) return { outcome: 'alreadyStored' };
  const known = lookup(message.id);
  const persona = findPersona(ctx, message, known);
  if (!persona) return { outcome: 'unattributed' };
  const row = buildRow(message, known, persona);
  return row ? { outcome: 'imported', row } : { outcome: 'skippedEmpty' };
};

const run = (ctx, ownBot, { lookup = () => null, dryRun = false } = {}) => {
  const counts = { imported: 0, alreadyStored: 0, unattributed: 0, skippedEmpty: 0 };
  const unattributedIds = [];
  ownBot.forEach((message) => {
    const { outcome, row } = examine(ctx, message, lookup);
    counts[outcome] += 1;
    if (outcome === 'unattributed') unattributedIds.push(message.id);
    if (row && !dryRun) ctx.botMessageStore.insert(row);
  });
  reportUnattributed(ctx, unattributedIds);
  return counts;
};

export const createBotMessageImporter = (deps) => ({
  run: (ownBot, options) => run(deps, ownBot, options),
});
