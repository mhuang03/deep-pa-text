import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, NOT_APPLIED, NEXT_STEPS } from '../../../src/backfill/reimportReport.js';

const planned = { applied: false, fetched: 5, humans: 3, ownBot: 1, otherBots: 1, wouldKeep: 2 };
const applied = {
  ...planned,
  applied: true,
  backupPath: '/x/messages.db.old',
  generation: 'g1',
  imported: { insertedRaw: 3, kept: 2, botMessages: 1, unattributedBotMessages: 0, skippedEmptyBotMessages: 0 },
  sync: { checked: 2 },
  comparison: { old: { raw: 4 }, new: { raw: 3 }, missingInNew: 1, changedContent: 0 },
};

test('a dry run prints the plan and says nothing was changed', () => {
  const lines = formatReport(planned);
  assert.ok(lines.some((line) => line.includes('fetched from Discord: 5')));
  assert.equal(lines.at(-1), NOT_APPLIED);
});

test('an applied run prints the backup, generation, old collections note and next steps', () => {
  const text = formatReport(applied).join('\n');
  assert.match(text, /Backup: \/x\/messages\.db\.old/);
  assert.match(text, /Chroma generation: g1/);
  assert.match(text, /old Chroma collections were left in place/);
  NEXT_STEPS.forEach((line) => assert.ok(text.includes(line)));
  assert.doesNotMatch(text, /WARNING/);
});

test('unattributed bot messages produce a warning', () => {
  const text = formatReport({ ...applied, imported: { ...applied.imported, unattributedBotMessages: 2 } }).join('\n');
  assert.match(text, /WARNING: 2 bot messages/);
});
