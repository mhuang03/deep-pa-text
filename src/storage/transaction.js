// fn must be synchronous: the connection is shared, so awaiting inside would interleave other writes.
export const runInTransaction = (db, fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
