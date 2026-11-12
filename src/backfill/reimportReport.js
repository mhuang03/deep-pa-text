// Plain-text lines for the re-import script; pure so they can be tested.
const countLine = (label, value) => `  ${label}: ${value}`;

const planLines = (report) => [
  'Plan:',
  countLine('messages fetched from Discord', report.fetched),
  countLine('human messages', report.humans),
  countLine('the bot\'s own messages', report.ownBot),
  countLine('other bots\' messages (dropped)', report.otherBots),
  countLine('human messages the corpus filter would keep', report.wouldKeep),
];

const appliedLines = (report) => {
  const { imported, sync, comparison } = report;
  return [
    'Imported:',
    countLine('raw messages', imported.insertedRaw),
    countLine('corpus rows', imported.kept),
    countLine('bot messages', imported.botMessages),
    countLine('bot messages skipped as empty', imported.skippedEmptyBotMessages),
    countLine('vector sync', JSON.stringify(sync)),
    'Compared with the backup:',
    countLine('old', JSON.stringify(comparison.old)),
    countLine('new', JSON.stringify(comparison.new)),
    countLine('ids missing in the new database (deleted since)', comparison.missingInNew),
    countLine('ids whose content differs (edited since)', comparison.changedContent),
  ];
};

export const NEXT_STEPS = [
  'Next steps:',
  '  1. Run npm run backfill once before starting the bot: it picks up anything posted during the re-import.',
  '  2. Start the bot. It uses the new generation automatically.',
  '  Rollback: stop the bot, move messages.db aside, rename messages.db.old to messages.db.',
  '  The backup and the old Chroma collections stay until someone removes them by hand.',
];

export const NOT_APPLIED = 'Nothing was changed. Re-run with --yes to apply.';

export const formatReport = (report) => {
  const lines = [...planLines(report)];
  if (!report.applied) return [...lines, '', NOT_APPLIED];
  lines.push('', ...appliedLines(report), '');
  lines.push(`Backup: ${report.backupPath}`, `Chroma generation: ${report.generation}`);
  lines.push('The old Chroma collections were left in place.');
  if (report.imported.unattributedBotMessages > 0) {
    lines.push(`WARNING: ${report.imported.unattributedBotMessages} bot messages had no recognisable persona and were not stored.`);
  }
  return [...lines, '', ...NEXT_STEPS];
};
