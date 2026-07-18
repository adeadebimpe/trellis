export interface ArchivableTask {
  id: string;
  status: string;
  lastUpdated: string;
}

export function selectMergedTasksToArchive(tasks: ArchivableTask[], visibleLimit = 10): string[] {
  if (visibleLimit < 0) {
    throw new Error('Visible merged-task limit cannot be negative.');
  }
  const merged = tasks
    .filter((task) => task.status === 'merged')
    .sort((a, b) => a.lastUpdated.localeCompare(b.lastUpdated) || a.id.localeCompare(b.id));
  return merged.slice(0, Math.max(0, merged.length - visibleLimit)).map((task) => task.id);
}
