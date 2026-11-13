import { topicPrefix } from '../text/topicEligibility.js';
import { authorStats, medianOf, medianTextLength } from './clusterStats.js';

const mostCommonShare = (values) => {
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return Math.max(0, ...counts.values()) / values.length;
};

const describe = (rows, { members, index, cohesion }) => {
  const memberRows = members.map((row) => rows[row]);
  const authors = authorStats(memberRows);
  return {
    index,
    members,
    size: members.length,
    authorCount: authors.length,
    authors,
    cohesion,
    medianTimestamp: medianOf(memberRows.map((row) => row.timestamp)),
    medianChars: medianTextLength(memberRows.map((row) => row.content)),
    prefixShare: mostCommonShare(memberRows.map((row) => topicPrefix(row.content))),
  };
};

const passes = (cluster, { settings, directorySize }) => cluster.size >= settings.minClusterSize
  && cluster.authorCount >= Math.min(settings.minAuthors, directorySize)
  && cluster.medianChars >= settings.minMedianChars
  && cluster.authors[0].share <= settings.maxAuthorShare
  && cluster.prefixShare <= settings.maxPrefixShare;

const membersByCluster = (assignments, count) => {
  const groups = Array.from({ length: count }, () => []);
  assignments.forEach((cluster, row) => groups[cluster].push(row));
  return groups;
};

// rows[i] belongs to cluster assignments[i]. Largest clusters first: the tightest ones are the most formulaic.
export const selectClusters = ({ rows, assignments, cohesion, directorySize, settings }) => {
  const groups = membersByCluster(assignments, cohesion.length);
  return groups
    .map((members, index) => (members.length === 0 ? null : describe(rows, { members, index, cohesion: cohesion[index] })))
    .filter((cluster) => cluster !== null && passes(cluster, { settings, directorySize }))
    .sort((a, b) => b.size - a.size || b.cohesion - a.cohesion || a.index - b.index)
    .slice(0, settings.maxLabelled);
};
