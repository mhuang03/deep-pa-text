// Applied to generated output only: a model must not be able to post a link under another member's name.
const MARKDOWN_LINK = /\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g;
const BARE_URL = /<?\b[a-z][a-z0-9+.-]*:\/\/[^\s>]+>?/gi;
const WWW_HOST = /<?\bwww\.[^\s>]+>?/gi;
const INVITE = /<?\b(?:(?:discord\.gg|dsc\.gg)\/|(?:discord|discordapp)\.com\/invite\/)[^\s>]*>?/gi;

export const stripLinks = (text) => text
  .replace(MARKDOWN_LINK, '$1')
  .replace(BARE_URL, '')
  .replace(WWW_HOST, '')
  .replace(INVITE, '');
