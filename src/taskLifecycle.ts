import { AgentBoardTask } from './types';

export function assertBoardActionAllowed(task: AgentBoardTask, action: string): void {
  switch (action) {
    case 'mark-building':
      if (task.status !== 'ready-for-agent') throw new Error('Only a ready task can start building.');
      throw new Error('Start builds through the assigned agent so Trellis can create and record a claim.');
    case 'mark-ready-qa':
      throw new Error('Complete builds through the agent workflow so Trellis can verify the tested code state.');
    case 'start-qa':
      throw new Error('Start QA through the assigned QA agent so Trellis can create and record a QA claim.');
    case 'pass-qa':
      throw new Error('Pass QA through the agent workflow so Trellis can verify fresh QA evidence.');
    case 'fail-qa':
      throw new Error('Fail QA through the active QA workflow so Trellis can verify QA ownership.');
    case 'mark-done':
      if (task.status !== 'human-review') throw new Error('Only a legacy Human Review task can be marked done.');
      return;
    default:
      return;
  }
}

export function assertStatusChangeAllowed(task: AgentBoardTask, nextStatus: AgentBoardTask['status']): void {
  if (task.status === nextStatus) return;
  const guardedAction: Partial<Record<AgentBoardTask['status'], string>> = {
    building: 'mark-building',
    'ready-for-qa': 'mark-ready-qa',
    'qa-running': 'start-qa',
    'human-review': 'pass-qa',
    'failed-qa': 'fail-qa',
    done: 'mark-done'
  };
  const action = guardedAction[nextStatus];
  if (action) assertBoardActionAllowed(task, action);
}
