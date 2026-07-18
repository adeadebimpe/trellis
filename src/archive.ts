export interface ArchivableTask {
  id: string;
  status: string;
  lastUpdated: string;
}

export function selectDoneTasksToArchive(tasks: ArchivableTask[], visibleLimit = 10): string[] {
  if (visibleLimit < 0) {
    throw new Error('Visible done-task limit cannot be negative.');
  }
  // Done and Merged are both terminal lanes; each keeps its own visible window.
  return ['done', 'merged'].flatMap((status) => {
    const terminal = tasks
      .filter((task) => task.status === status)
      .sort((a, b) => a.lastUpdated.localeCompare(b.lastUpdated) || a.id.localeCompare(b.id));
    return terminal.slice(0, Math.max(0, terminal.length - visibleLimit)).map((task) => task.id);
  });
}
