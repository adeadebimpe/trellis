import { join } from 'node:path';

export type StateDirectoryAction = 'uninitialized' | 'current' | 'migrate-legacy' | 'conflict';

export function stateDirectoryAction(hasCurrent: boolean, hasLegacy: boolean): StateDirectoryAction {
  if (hasCurrent && hasLegacy) return 'conflict';
  if (hasCurrent) return 'current';
  if (hasLegacy) return 'migrate-legacy';
  return 'uninitialized';
}

export function migratedWorktreePaths(currentDirectory: string, entries: Array<[string, number]>, directoryType: number): string[] {
  return entries
    .filter(([, type]) => type === directoryType)
    .map(([name]) => join(currentDirectory, 'worktrees', name));
}
