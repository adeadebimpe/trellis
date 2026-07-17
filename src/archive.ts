export interface ArchivableTask {
  id: string;
  status: string;
  lastUpdated: string;
}

export function selectDoneTasksToArchive(tasks: ArchivableTask[], visibleLimit = 10): string[] {
  if (visibleLimit < 0) {
    throw new Error('Visible done-task limit cannot be negative.');
  }
  const done = tasks
    .filter((task) => task.status === 'done')
    .sort((a, b) => a.lastUpdated.localeCompare(b.lastUpdated) || a.id.localeCompare(b.id));
  return done.slice(0, Math.max(0, done.length - visibleLimit)).map((task) => task.id);
}
