import { USERS, PING_CACHE } from './data.js';

// build a set of valid usernames (only these will be counted)
const validUsernames = new Set(USERS.map(u => u.username));



const commandPrefixes = ['!', '$', '#', '%', '&', '-', '+', 'p!'];

// transformers that we want to apply to messages before filtering
// applied to the message content, in order, before running filters
const TRANSFORMERS = {
  // remove <@id> and <@!id> mentions
  handleMentions: m => { 
    // if the message is just a bunch of mentions and nothing else, remove it entirely
    let copy = m;
    let removed = copy.replace(/<(@!?|@&|#)\d+>/g, '');
    if (removed.trim() === '') return '';
    
    // otherwise replace mentions with resolved names from the ping cache, e.g. <@123> -> @username
    m = m.replace(/<@!?(\d+)>/g, (match, p1) => {
      return PING_CACHE.users[p1] ? `@${PING_CACHE.users[p1]}` : '';
    });
    m = m.replace(/<@&(\d+)>/g, (match, p1) => {
      return PING_CACHE.roles[p1] ? `@${PING_CACHE.roles[p1]}` : '';
    });
    m = m.replace(/<#(\d+)>/g, (match, p1) => {
      return PING_CACHE.channels[p1] ? `#${PING_CACHE.channels[p1]}` : '';
    });
    return m;
  },
  handleTenor: m => m.replace(/https?:\/\/tenor\.com\/view\/([^\/]+)-\d+(\?\S+)?/g, (match, p1) => {
      const searchTerms = p1.split('-');
      let deduped = new Set(searchTerms);
      deduped.delete('tenor');
      deduped.delete('gif');
      return `<gif! ${Array.from(deduped).join(' ')}>`;
    }),
  removeUrls: m => {
    // detect markdown links of the form [text](url) and remove the url part
    m = m.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1');

    // sometimes there is a newline between https:// and the rest of the url, so remove that newline
    m = m.replace(/https?:\/\/\n/g, 'https://');

    // split by whitespaces, attempt to parse as URL, and remove if valid
    let urls = m.split(/\s+/).filter(word => {
      try {
        if (!word.includes('://')) return false; // skip if it doesn't look like a URL at all
        
        // isolate url part in case there are random characters around it, e.g. <https://example.com>
        let isolated = word.match(/https?:\/\/[^\s]+/);
        if (isolated) {
          word = isolated[0];
        }

        // sometimes the url is in the form <https://example.com>, so remove angle brackets before parsing
        word = word.replace(/^<|>$/g, '');
        new URL(word);
        return true;
      } catch (e) {
        return false;
      }
    });
    urls.forEach(url => {
      m = m.replace(url + ' ', '');
      m = m.replace(url + '\n', '');
      m = m.replace(url, '');
    });

    return m;
  },
  replaceCustomEmojis: m => m.replace(/<a?(:\w+:)\d+>/g, '$1'),
  removeDynamicTimeObjects: m => m.replace(/<t:\d+(:\w+)?>/g, ''),
  removeSoundboards: m => m.replace(/<:sound:\d+:\d+>/g, ''),
  removeDiscordLinks: m => m.replace(/(https?:\/\/(www\.)?)?discord\.gg\/\S+/g, ''),
  trim: m => m.trim(),
};

// bunch of filters that we want to apply to messages
// these return true if the message should be kept, false if it should be filtered out
const FILTERS = {
  approvedAuthors: m => validUsernames.has(m.author),
  hasContent: m => Boolean(m.content),
  minLength: m => m.content.length >= 5,
  maxLength: m => m.content.length <= 200,
  noCommands: m => commandPrefixes.every(p => !m.content.startsWith(p)),
  noConnections: m => !m.content.includes("Connections") && !m.content.includes("Puzzle #"),
  noWordles: m => !m.content.match(/Wordle \d+ \d\/\d/g),
  noStrands: m => !m.content.match(/Strands #\d+/g),
}

// returns null if the message should be filtered out, otherwise returns the transformed message
export const filter = (msg) => {
  msg.content = msg.content || "";
  Object.values(TRANSFORMERS).forEach(t => {
    msg.content = t(msg.content);
  });
  return Object.values(FILTERS).every(f => f(msg)) ? msg : null;
};

// same as filter, but doesn't check for approved authors
export const filterAnyAuthor = (msg) => {
  msg.content = msg.content || "";
  Object.values(TRANSFORMERS).forEach(t => {
    msg.content = t(msg.content);
  });
  return Object.values(FILTERS).slice(1).every(f => f(msg)) ? msg : null;
};