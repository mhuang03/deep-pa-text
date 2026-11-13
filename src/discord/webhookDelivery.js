import { MessageFlags } from 'discord.js';
import { buildPayload, SAFE_MENTIONS } from './payload.js';
import { toWebhookName } from './webhookName.js';
import { UNKNOWN_WEBHOOK_CODE, NOT_FOUND_STATUS } from './errorCodes.js';
import { truncateForDiscord } from '../text/truncate.js';

export const REPLY_LINK_PREFIX = '-# ↪ ';

const EPHEMERAL_VIAS = ['interaction', 'followUp'];

const isWebhookGone = (error) => error?.code === UNKNOWN_WEBHOOK_CODE || error?.status === NOT_FOUND_STATUS;

const warnOnce = ({ warned, logger }, channel, error) => {
  const key = `${channel.id}:${error?.message}`;
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(`Webhook delivery failed in channel ${channel.id}; using the embed form:`, error);
};

// The interaction's placeholder is ephemeral, so the persona message goes to the channel instead.
const fallbackRequest = (request) => (EPHEMERAL_VIAS.includes(request.via.type)
  ? { ...request, via: { type: 'channel', channel: request.channel } }
  : request);

// A webhook message cannot be a native reply, so the message it answers is linked instead:
// the replied message, or the one a command was used on.
const answeredMessage = (via) => {
  if (via.type === 'reply') return via.message;
  return via.type === 'interaction' ? via.replyTo : null;
};

const withReplyLink = ({ config }, content, via) => {
  const { webhookReplyLink, maxMessageLength, truncateLookbackChars } = config.discord;
  const url = answeredMessage(via)?.url;
  if (!webhookReplyLink || !url) return content;
  return truncateForDiscord(`${REPLY_LINK_PREFIX}${url}\n${content}`, {
    maxLength: maxMessageLength, lookback: truncateLookbackChars,
  });
};

const sendThrough = (ctx, webhook, { request, name, profile }) => {
  const { via, content, gifLinks } = request;
  return webhook.send({
    content: withReplyLink(ctx, content, via),
    username: name,
    avatarURL: profile.avatarURL ?? undefined,
    embeds: buildPayload({ content, gifLinks, maxEmbeds: ctx.config.discord.maxEmbeds }).embeds,
    allowedMentions: SAFE_MENTIONS,
  });
};

const getWebhook = async ({ webhooks }, channel) => {
  try {
    return await webhooks.forChannel(channel);
  } catch (error) {
    webhooks.forget(channel);
    throw error;
  }
};

const viaWebhook = async (ctx, request, sendArgs) => {
  const { channel } = request;
  try {
    const webhook = await getWebhook(ctx, channel);
    try {
      return await sendThrough(ctx, webhook, sendArgs);
    } catch (error) {
      if (isWebhookGone(error)) ctx.webhooks.forget(channel);
      throw error;
    }
  } catch (error) {
    warnOnce(ctx, channel, error);
    return ctx.fallback.deliver(fallbackRequest(request));
  }
};

// The message is already out: a failed confirmation is logged, not allowed to lose its record.
const confirmInteraction = async ({ logger }, via, persona) => {
  if (via.type !== 'interaction') return;
  try {
    await via.interaction.editReply({ content: `Sent as ${persona}.`, allowedMentions: SAFE_MENTIONS });
  } catch (error) {
    logger.error(`Could not confirm the reply sent as ${persona}:`, error);
  }
};

const deliver = async (ctx, request) => {
  const { persona, guild } = request;
  const profile = await ctx.memberProfiles.current(persona, guild);
  const name = toWebhookName(profile.displayName, persona, ctx.config.discord.webhookUsernameMax);
  const message = name === null
    ? await ctx.fallback.deliver(fallbackRequest(request))
    : await viaWebhook(ctx, request, { request, name, profile });
  await confirmInteraction(ctx, request.via, persona);
  return message;
};

export const createWebhookDelivery = ({ webhooks, memberProfiles, fallback, config, logger }) => {
  const ctx = { webhooks, memberProfiles, fallback, config, logger, warned: new Set() };
  return {
    deliver: (request) => deliver(ctx, request),
    // deferReply sets the ephemeral flag; editReply cannot change it.
    placeholder: async ({ persona }) => ({
      content: `Replying as ${persona}…`,
      allowedMentions: SAFE_MENTIONS,
    }),
    deferOptions: () => ({ flags: MessageFlags.Ephemeral }),
  };
};
