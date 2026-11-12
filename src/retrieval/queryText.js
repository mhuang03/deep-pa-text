// A short message such as "why" has nothing to match on, so it borrows the lines before it.
export const buildQueryText = (record, transcript, { shortMessageChars, queryContextMessages }) => {
  const isLong = record.content.length >= shortMessageChars;
  if (isLong || queryContextMessages <= 0 || transcript.length === 0) return record.content;
  const context = transcript.slice(-queryContextMessages).map((entry) => entry.content);
  return [...context, record.content].join('\n');
};
