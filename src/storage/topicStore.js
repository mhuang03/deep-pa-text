import { normalizeForDedup } from '../text/normalize.js';
import { runInTransaction } from './transaction.js';
import * as sql from './topicSql.js';

const toTopic = (row, authors) => ({
  id: row.id,
  label: row.label,
  summary: row.summary,
  size: row.size,
  authorCount: row.author_count,
  cohesion: row.cohesion,
  medianTimestamp: row.median_timestamp,
  authors: authors.get(row.id) ?? [],
});

const groupAuthors = (rows) => {
  const byTopic = new Map();
  rows.forEach((row) => {
    const list = byTopic.get(row.topic_id) ?? [];
    list.push({ author: row.author, share: row.share, newestTimestamp: row.newest_timestamp });
    byTopic.set(row.topic_id, list);
  });
  return byTopic;
};

const insertTopic = (statements, topic) => {
  const { buildId, label, summary, size, authorCount, cohesion, medianTimestamp } = topic;
  const result = statements.topic.run(buildId, label, summary, size, authorCount, cohesion, medianTimestamp);
  const id = Number(result.lastInsertRowid);
  topic.authors.forEach(({ author, share, newestTimestamp }) => {
    statements.author.run(id, author, share, newestTimestamp);
  });
  topic.messages.forEach((messageId, rank) => statements.message.run(id, messageId, rank));
  return id;
};

const currentBuild = ({ statements }) => {
  const row = statements.currentBuild.get();
  return row ? { buildId: row.build_id, completedAt: row.completed_at } : null;
};

const currentTopics = (ctx) => {
  const build = currentBuild(ctx);
  if (!build) return [];
  const authors = groupAuthors(ctx.statements.authors.all(build.buildId));
  return ctx.statements.topics.all(build.buildId).map((row) => toTopic(row, authors));
};

const prepare = (db) => ({
  build: db.prepare(sql.INSERT_BUILD),
  topic: db.prepare(sql.INSERT_TOPIC),
  author: db.prepare(sql.INSERT_AUTHOR),
  message: db.prepare(sql.INSERT_MESSAGE),
  currentBuild: db.prepare(sql.CURRENT_BUILD),
  topics: db.prepare(sql.TOPICS_OF_BUILD),
  authors: db.prepare(sql.AUTHORS_OF_BUILD),
  samples: db.prepare(sql.SAMPLES_OF_TOPIC),
  hide: db.prepare(sql.HIDE_TOPIC),
  hidden: db.prepare(sql.HIDDEN_LABELS),
});

// Append-only: a build's topics are written first and its topic_builds row last, so an interrupted
// build is never current. `messages` is a list of corpus row ids, closest to the centre first.
export const createTopicStore = ({ db }) => {
  const statements = prepare(db);
  const ctx = { statements };
  return {
    insertTopic: (topic) => runInTransaction(db, () => insertTopic(statements, topic)),
    completeBuild: ({ buildId, completedAt, stats }) => {
      statements.build.run(buildId, completedAt, JSON.stringify(stats));
    },
    currentBuild: () => currentBuild(ctx),
    currentTopics: () => currentTopics(ctx),
    samplesOf: (topicId, limit) => statements.samples.all(topicId, limit)
      .map((row) => ({ author: row.author, text: row.content })),
    hide: (id, at) => Number(statements.hide.run(at, id).changes) > 0,
    hiddenLabelKeys: () => new Set(statements.hidden.all().map((row) => normalizeForDedup(row.label))),
  };
};
