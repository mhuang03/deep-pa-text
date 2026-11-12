// Raw ids of the backup are looked up in the new database: absent means deleted since (or outside the
// channel), a different content means edited since.
export const compareArchives = ({ oldArchive, newArchive, messageStore, pageSize }) => {
  let missingInNew = 0;
  let changedContent = 0;
  let afterId = null;
  for (;;) {
    const page = oldArchive.rawPage({ afterId, limit: pageSize });
    if (page.length === 0) break;
    page.forEach(({ id, content }) => {
      const current = messageStore.getRaw(id);
      if (!current) missingInNew += 1;
      else if (current.content !== content) changedContent += 1;
    });
    afterId = page.at(-1).id;
  }
  return { old: oldArchive.counts(), new: newArchive.counts(), missingInNew, changedContent };
};
