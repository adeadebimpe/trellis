export type WorkflowPromptKind = 'implementation' | 'qa' | 'repair';

export interface WorkflowPromptTemplates {
  implementation?: string;
  qa?: string;
  repair?: string;
}

export interface WorkflowPromptValues {
  taskId: string;
  repositoryPath: string;
  worktreePath: string;
  branchName: string;
  scriptsPath: string;
  agent: string;
}

export const WORKFLOW_PROMPT_PLACEHOLDERS = [
  'taskId',
  'repositoryPath',
  'worktreePath',
  'branchName',
  'scriptsPath',
  'agent'
] as const;

export const DEFAULT_WORKFLOW_PROMPTS: Record<WorkflowPromptKind, string> = {
  implementation: [
    'You are the assigned implementation agent for Trellis task {{taskId}}.',
    '{{workspaceInstruction}}',
    'The durable task record lives in the MAIN checkout: {{repositoryPath}}/.trellis/tasks/{{taskId}}.json. Never edit .trellis files inside a worktree; the board scripts resolve the main checkout automatically.',
    'Read {{repositoryPath}}/.trellis/project.json and the task JSON before editing, including the latest comments, activityLog, and qaNotes entries for human or QA feedback.',
    'Implement only this task. Update relevantFiles, agentNotes, and activityLog in the main task file as you work.',
    'When implementation is complete: run node "{{scriptsPath}}/run-validation.mjs" {{taskId}} (required - it records validation evidence), then node "{{scriptsPath}}/complete-task.mjs" {{taskId}}.',
    'Then run node "{{scriptsPath}}/claim-next-task.mjs" {{agent}} terminal. If it returns a task, continue in its printed worktree and repeat until it prints {"noTask":true}.',
    'If blocked, update the task with a blocker note and move it to human-review.'
  ].join('\n'),
  qa: [
    'You are the QA agent for Trellis task {{taskId}}.',
    '{{workspaceInstruction}}',
    'The durable task record lives in the MAIN checkout: {{repositoryPath}}/.trellis/tasks/{{taskId}}.json. Never edit .trellis files inside a worktree.',
    'Read {{repositoryPath}}/.trellis/project.json and the task JSON.',
    'Review acceptanceCriteria, qaChecklist, designQaChecklist, changed files on the branch, agentNotes, and validation evidence.',
    'Run node "{{scriptsPath}}/run-validation.mjs" {{taskId}} to verify the validation commands pass, plus any functional checks the task calls for. Record findings in qaEvidence.',
    'If QA passes, run: node "{{scriptsPath}}/pass-qa.mjs" {{taskId}} "QA passed."',
    'If QA fails, run: node "{{scriptsPath}}/fail-qa.mjs" {{taskId}} "specific failure reason"'
  ].join('\n'),
  repair: [
    'You are the implementation agent automatically repairing failed QA for Trellis task {{taskId}}.',
    '{{workspaceInstruction}}',
    'Read the durable task record at {{repositoryPath}}/.trellis/tasks/{{taskId}}.json, especially the latest comments, qaNotes, qaEvidence, activityLog, and failed validation output.',
    'Also read {{repositoryPath}}/.trellis/project.json before editing.',
    'Fix the specific QA failure without expanding task scope. Update agentNotes, relevantFiles, and activityLog as you work.',
    'When repaired, run node "{{scriptsPath}}/run-validation.mjs" {{taskId}}, then node "{{scriptsPath}}/complete-task.mjs" {{taskId}}. QA will start again automatically.',
    'Then run node "{{scriptsPath}}/claim-next-task.mjs" {{agent}} terminal and continue any returned task until it prints {"noTask":true}.',
    'If the failure cannot be repaired safely, record the blocker and move the task to human-review.'
  ].join('\n')
};

export function renderWorkflowPrompt(
  kind: WorkflowPromptKind,
  template: string | undefined,
  values: WorkflowPromptValues
): string {
  const selected = template?.trim() ? template : DEFAULT_WORKFLOW_PROMPTS[kind];
  const workspaceInstruction = workspaceInstructionFor(kind, values);
  const replacements: Record<string, string> = { ...values, workspaceInstruction };
  return selected.replace(/\{\{(taskId|repositoryPath|worktreePath|branchName|scriptsPath|agent|workspaceInstruction)\}\}/g, (_, key: string) => replacements[key]);
}

function workspaceInstructionFor(kind: WorkflowPromptKind, values: WorkflowPromptValues): string {
  if (values.worktreePath && values.branchName) {
    if (kind === 'implementation') {
      return `Your working directory is a dedicated git worktree on branch ${values.branchName}. Do all code work here and commit to this branch.`;
    }
    if (kind === 'qa') {
      return `Your working directory is the task's git worktree on branch ${values.branchName}; review the implementation here.`;
    }
    return `Work only in the existing task worktree on branch ${values.branchName}. Commit the repair to this branch.`;
  }
  if (kind === 'qa') {
    return 'Review the direct-on-main implementation in the repository root.';
  }
  if (kind === 'repair') {
    return 'This repair uses direct-on-main mode. Work in the repository root and keep the repair scoped to this task.';
  }
  return 'This task uses direct-on-main mode. Work in the repository root, keep changes scoped to this task, and do not start another build concurrently.';
}
