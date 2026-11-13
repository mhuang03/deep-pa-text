import * as sql from './messageSql.js';
import * as topicSql from './messageTopicSql.js';

const toSample = (row) => ({ id: row.id, author: row.author, content: row.content, timestamp: row.timestamp });

// Reads that feed the topic bank: random corpus samples and the starters of every author.
export const createMessageTopicQueries = ({ db }) => {
  const recent = db.prepare(topicSql.TOPIC_SAMPLE_RECENT);
  const older = db.prepare(topicSql.TOPIC_SAMPLE_OLDER);
  const corpus = db.prepare(topicSql.RANDOM_CORPUS);
  const starters = db.prepare(sql.RANDOM_STARTERS_ALL);
  return {
    topicSample: ({ minChars, sinceMs, recentLimit, olderLimit }) => [
      ...recent.all(minChars, sinceMs, recentLimit),
      ...older.all(minChars, sinceMs, olderLimit),
    ].map(toSample),
    randomCorpus: ({ minChars, limit }) => corpus.all(minChars, limit).map(toSample),
    randomStartersAll: ({ minGapMs, limit }) => starters.all(minGapMs, limit)
      .map((row) => ({ author: row.author, content: row.content })),
  };
};
