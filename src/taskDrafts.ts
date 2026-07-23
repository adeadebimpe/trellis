import type { PrdTaskSeed } from './ai';
import type { AgentSpecPatch } from './prdPrompt';
import type { ActivityEntry, AgentBoardTask } from './types';

export function prdSplitDraftPatch(
  seed: PrdTaskSeed,
  activityLog: ActivityEntry[],
  timestamp: string
): Partial<AgentBoardTask> & { status: 'backlog' } {
  return {
    title: seed.title,
    brief: seed.brief,
    description: seed.description,
    acceptanceCriteria: seed.acceptanceCriteria,
    priority: seed.priority,
    status: 'backlog',
    activityLog: [
      ...activityLog,
      { timestamp, actor: 'vscode', message: 'Created from PRD split in Backlog for review.' }
    ]
  };
}

export function generatedSpecDraftPatch(
  task: AgentBoardTask,
  specPatch: Omit<AgentSpecPatch, 'title'>,
  title: string,
  actor: string,
  timestamp: string
): Partial<AgentBoardTask> {
  return {
    title,
    ...specPatch,
    activityLog: [
      ...(task.activityLog ?? []),
      { timestamp, actor, message: 'Generated PRD. Kept in current status for review.' }
    ]
  };
}
