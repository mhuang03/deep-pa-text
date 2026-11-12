import { MessageFlags } from 'discord.js';
import { buildPayload, SAFE_MENTIONS } from './payload.js';
import { toWebhookName } from './webhookName.js';
import { truncateForDiscord } from '../llm/sanitize.js';

export const REPLY_LINK_PREFIX = '-# ↪ ';

const UNKNOWN_WEBHOOK_CODE = 10015;
const NOT_FOUND_STATUS = 404;
const EPHEMERAL_VIAS = ['interaction', 'followUp'];

const isWebhookGone = (error) => error?.code === UNKNOWN_WEBHOOK_CODE || error?.status === NOT_FOUND_STATUS;

export const createWebhookDelivery = ({ webhooks, memberProfiles, fallback, config, logger }) => {
  const { maxMessageLength, truncateLookbackChars, webhookReplyLink, webhookUsernameMax } = config.discord;
  const warned = new Set();

  const warnOnce = (channel, error) => {
    const key = `${channel.id}:${error?.message}`;
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(`Webhook delivery failed in channel ${channel.id}; using the embed form:`, error);
  };

  // The interaction's placeholder is ephemeral, so the persona message goes to the channel instead.
  const fallbackRequest = (request) => (EPHEMERAL_VIAS.includes(request.via.type)
    ? { ...request, via: { type: 'channel', channel: request.channel } }
    : request);

  const withReplyLink = (content, via) => {
    if (via.type !== 'reply' || !webhookReplyLink || !via.message?.url) return content;
    return truncateForDiscord(`${REPLY_LINK_PREFIX}${via.message.url}\n${content}`, {
      maxLength: maxMessageLength, lookback: truncateLookbackChars,
    });
  };

  const sendThrough = async (webhook, { request, name, profile }) => {
    const { via, content, gifLinks } = request;
    return webhook.send({
      content: withReplyLink(content, via),
      username: name,
      avatarURL: profile.avatarURL ?? undefined,
      embeds: buildPayload({ content, gifLinks }).embeds,
      allowedMentions: SAFE_MENTIONS,
    });
  };

  const getWebhook = async (channel) => {
    try {
      return await webhooks.forChannel(channel);
    } catch (error) {
      webhooks.forget(channel);
      throw error;
    }
  };

  const viaWebhook = async (request, sendArgs) => {
    const { channel } = request;
    try {
      const webhook = await getWebhook(channel);
      try {
        return await sendThrough(webhook, sendArgs);
      } catch (error) {
        if (isWebhookGone(error)) webhooks.forget(channel);
        throw error;
      }
    } catch (error) {
      warnOnce(channel, error);
      return fallback.deliver(fallbackRequest(request));
    }
  };

  // The message is already out: a failed confirmation is logged, not allowed to lose its record.
  const confirmInteraction = async (via, persona) => {
    if (via.type !== 'interaction') return;
    try {
      await via.interaction.editReply({ content: `Sent as ${persona}.`, allowedMentions: SAFE_MENTIONS });
    } catch (error) {
      logger.error(`Could not confirm the reply sent as ${persona}:`, error);
    }
  };

  const deliver = async (request) => {
    const { persona, guild } = request;
    const profile = await memberProfiles.current(persona, guild);
    const name = toWebhookName(profile.displayName, persona, webhookUsernameMax);
    const message = name === null
      ? await fallback.deliver(fallbackRequest(request))
      : await viaWebhook(request, { request, name, profile });
    await confirmInteraction(request.via, persona);
    return message;
  };

  // deferReply sets the ephemeral flag; editReply cannot change it.
  const placeholder = async ({ persona }) => ({
    content: `Replying as ${persona}…`,
    allowedMentions: SAFE_MENTIONS,
  });

  const deferOptions = () => ({ flags: MessageFlags.Ephemeral });

  return { deliver, placeholder, deferOptions };
};
