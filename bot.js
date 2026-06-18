import { loadEnvFile } from 'node:process';
loadEnvFile('.env');

import { 
  EmbedBuilder, Client, GatewayIntentBits, Events, MessageFlags,
  ModalBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, LabelBuilder 
} from 'discord.js';
import { recordMessage, searchLikelyRepliers } from './db.js';
import { getRAGResponse, getRandomResponse, processGIFs } from './api.js';
import { filterAnyAuthor } from './filter.js';
import { USERS } from './data.js';

const REPLY_OVERRIDE = false; // set to true to reply to every message without randomness or rate limiting, for testing purposes
const REVIVE_OVERRIDE = false; // set to true to post a new message every minute regardless of last message time, for testing purposes
const PATEXT_CHANNEL_ID = '704837777564500149';
const BOTTESTING_CHANNEL_ID = '937203294693118023';
const REPLY_PROBABILITY = 0.1; // probability of replying to an acceptable message
const MIN_REPLY_INTERVAL = 5 * 60 * 1000; // minimum interval between replies in milliseconds



const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const makeAuthorEmbed = async (author, guild, think=false) => {
  let avatarUrl = null;

  try {
    const members = await guild.members.fetch({ query: author, limit: 1 });
    const member = members.first();
    avatarUrl = member?.displayAvatarURL() ?? null;
  } catch (e) {
    console.warn(`Could not fetch avatar for ${author}:`, e);
  }

  const embed = new EmbedBuilder()
    .setAuthor({ name: author, iconURL: avatarUrl })
    .setColor('#5865F2');
  if (think) embed.setFooter({ text: 'thinking...' });

  return embed;
};

let lastMessageTime = Date.now();
let lastMessageAuthor = "deep-pa-text";
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  setInterval(async () => {
    try {
      const elapsedTime = Date.now() - lastMessageTime;
      // is daytime in central time
      const centralTimeHourNow = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false });
      const isDaytime = parseInt(centralTimeHourNow) >= 7 && parseInt(centralTimeHourNow) <= 23;
      if (
        REVIVE_OVERRIDE
        || lastMessageAuthor !== "deep-pa-text" && elapsedTime > 3600000 // 1 hour
        || isDaytime && elapsedTime > 3*3600000 // 3 hours
        || !isDaytime && elapsedTime > 12*3600000 // 12 hours
      ) {

        // update last message time so that the bot doesn't try to send a message while it's already processing a message
        lastMessageTime = Date.now();
        lastMessageAuthor = "deep-pa-text";

        const channel = await client.channels.fetch(PATEXT_CHANNEL_ID);
        const guild = channel.guild ?? await guilds.fetch(channel.guildId);
        const author = USERS[Math.floor(Math.random() * USERS.length)].username;
        const response = await getRandomResponse(author);
        const { content, gifLinks } = await processGIFs(response);
        const embeds = [];
        for (let { url } of gifLinks) {
          if (url) {
            embeds.push(new EmbedBuilder().setImage(url));
          }
        }
        embeds.push(await makeAuthorEmbed(author, guild));

        console.log(`[REVIVE] ${author}: ${response}`);
        channel.send({ 
          embeds: embeds,
          content: content,
        });

        // reupdate last message time and author after sending the message for accuracy
        lastMessageTime = Date.now();
        lastMessageAuthor = "deep-pa-text";
      }
    } catch (e) {
      console.error('Error in revive interval:', e);
    }
  }, REVIVE_OVERRIDE ? 60000 : 10*60*1000); // run every 10 minutes if not in override mode, 1 minute if in override mode
});

let prevReplyTime = null;
let probabilityFailCount = 0;
client.on(Events.MessageCreate, async (message) => {
  if (message.channel.id !== PATEXT_CHANNEL_ID || message.author.bot) {
    return;
  }
  
  let msg = {
    id: message.id,
    author: message.author.username,
    content: message.content,
    timestamp: message.createdTimestamp,
    reference: message.reference?.messageId || null
  };

  lastMessageTime = message.createdTimestamp;
  lastMessageAuthor = message.author.username;

  try {
    const report = [];
    report.push(await recordMessage(msg));
    msg = filterAnyAuthor(msg);
    if (!msg) {
      report.push(`    [NOREPLY: not replyable]`);
      console.log(report.join('\n'));
      return;
    }

    if (!REPLY_OVERRIDE) {
      if (prevReplyTime && Date.now() - prevReplyTime < MIN_REPLY_INTERVAL) {
        report.push(`    [NOREPLY: rate limited]`);
        console.log(report.join('\n'));
        return;
      }
      let rand = Math.random();
      let replyChance = REPLY_PROBABILITY + Math.max(0, probabilityFailCount - 10)*0.05; // increase probability after 10 consecutive failures, up to 100% increase at 30 consecutive failures
      if (rand > replyChance) {
        report.push(`    [NOREPLY: random ${rand.toFixed(2)} > ${replyChance}]`);
        console.log(report.join('\n'));
        probabilityFailCount++;
        return;
      };
    }

    // update last message time so that the bot doesn't try to send a message while it's already processing a message
    lastMessageTime = Date.now();
    lastMessageAuthor = "deep-pa-text";

    const likelyRepliers = await searchLikelyRepliers(msg);
    const replyingAuthor = likelyRepliers[Math.floor(Math.random() * likelyRepliers.length)] 
      || USERS[Math.floor(Math.random() * USERS.length)].username;
    const response = await getRAGResponse(replyingAuthor, msg);
    const { content, gifLinks } = await processGIFs(response);
    const embeds = [];
    for (let { url } of gifLinks) {
      if (url) {
        embeds.push(new EmbedBuilder().setImage(url));
      }
    }
    embeds.push(await makeAuthorEmbed(replyingAuthor, message.guild));

    report.push(`    [REPLY] ${replyingAuthor}: ${response}`);
    message.reply({ 
      embeds,
      content,
    });

    prevReplyTime = Date.now();

    // reupdate last message time and author after sending the message for accuracy
    lastMessageTime = Date.now();
    lastMessageAuthor = "deep-pa-text";
    probabilityFailCount = 0;

    console.log(report.join('\n'));
  } catch (e) {
    console.error('Error processing message:', e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isMessageContextMenuCommand()) {
    if (interaction.commandName === 'reply') {
      const message = interaction.targetMessage;
      let msg = {
        id: message.id,
        author: message.author.username,
        content: message.content,
        timestamp: message.createdTimestamp,
        reference: message.reference?.messageId || null
      }
      msg = filterAnyAuthor(msg);
      if (!msg) {
        await interaction.reply({ content: 'The selected message is not replyable.', flags: MessageFlags.Ephemeral });
        return;
      }

      let guild = message.guild
      if (!guild) {
        guild = await client.guilds.fetch(message.guildId);
      }
      
      if (message.channel.id !== BOTTESTING_CHANNEL_ID) { // PATEXT_CHANNEL_ID) {
        await interaction.reply({ content: 'This command can only be used in the #pa-text channel.', flags: MessageFlags.Ephemeral });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId('replyModal')
        .setTitle('Reply to a message using deep pa-text');

      const authorSelect = new StringSelectMenuBuilder()
        .setCustomId('authorSelect')
        .setPlaceholder('Select an author')
        .addOptions(USERS.map(
          user => new StringSelectMenuOptionBuilder()
                    .setLabel(user.username)
                    .setDescription(`Reply as ${user.name}`)
                    .setValue(user.username)
        ));

      const label = new LabelBuilder()
        .setLabel('Who should I reply as?')
        .setStringSelectMenuComponent(authorSelect);

      modal.addLabelComponents(label);

      await interaction.showModal(modal);

      await interaction.awaitModalSubmit({ time: 2 * 60 * 1000 }) // wait up to 2 minutes for the user to submit the modal
        .then(async (modalInteraction) => {
          if (modalInteraction.customId !== 'replyModal') return;
          const authorSelect = modalInteraction.fields.getStringSelectValues('authorSelect');
          const replyingAuthor = authorSelect[0];

          await modalInteraction.reply({ embeds: [await makeAuthorEmbed(replyingAuthor, guild, true)] });
          
          const response = await getRAGResponse(replyingAuthor, msg);
          const { content, gifLinks } = await processGIFs(response);
          const embeds = [];
          for (let { url } of gifLinks) {
            if (url) {
              embeds.push(new EmbedBuilder().setImage(url));
            }
          }
          embeds.push(await makeAuthorEmbed(replyingAuthor, guild));

          await modalInteraction.editReply({ 
            embeds,
            content,
          });
        })
        .catch((err) => {
          console.error('Error handling modal submission:', err);
        });
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);