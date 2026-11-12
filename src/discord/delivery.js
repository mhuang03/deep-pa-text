import { buildPayload, withSafeMentions } from './payload.js';

// Each delivery type says how to send and which mention options its payload carries.
const SENDERS = {
  reply: (via, config) => ({
    mentions: { repliedUser: config.discord.pingRepliedUser },
    send: (payload) => via.message.reply(payload),
  }),
  channel: (via) => ({ mentions: {}, send: (payload) => via.channel.send(payload) }),
  followUp: (via) => ({ mentions: {}, send: (payload) => via.interaction.followUp(payload) }),
  interaction: (via) => ({ mentions: {}, send: (payload) => via.interaction.editReply(payload) }),
};

export const createEmbedDelivery = ({ authorEmbeds, config }) => {
  const resolveSender = (via) => {
    const build = Object.hasOwn(SENDERS, via?.type) ? SENDERS[via.type] : null;
    if (!build) throw new Error(`unknown delivery type: ${via?.type}`);
    return build(via, config);
  };

  const deliver = async ({ via, persona, guild, content, gifLinks }) => {
    const sender = resolveSender(via);
    const authorEmbed = await authorEmbeds.make(persona, guild);
    const payload = withSafeMentions(buildPayload({ content, gifLinks, authorEmbed }), sender.mentions);
    return sender.send(payload);
  };

  const placeholder = async ({ persona, guild }) => {
    const thinking = await authorEmbeds.make(persona, guild, { thinking: true });
    return withSafeMentions({ embeds: [thinking] });
  };

  return { deliver, placeholder };
};
