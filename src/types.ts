export const TASK_STATUSES = [
  'backlog',
  'ready-for-agent',
  'building',
  'ready-for-qa',
  'qa-running',
  'failed-qa',
  'human-review',
  'done'
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AssignedAgent = 'claude' | 'codex' | 'unassigned';
export type Priority = 'high' | 'medium' | 'low';

export interface ActivityEntry {
  timestamp: string;
  actor: string;
  message: string;
}

export interface AgentBoardTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  assignedAgent: AssignedAgent;
  qaAgent: AssignedAgent;
  brief: string;
  description: string;
  acceptanceCriteria: string[];
  qaChecklist: string[];
  designQaChecklist: string[];
  validationCommands: string[];
  relevantFiles: string[];
  constraints: string[];
  agentNotes: string;
  qaNotes: ActivityEntry[];
  qaEvidence: string[];
  activityLog: ActivityEntry[];
  claimedBy: string;
  qaClaimedBy: string;
  branchName: string;
  lastUpdated: string;
  [key: string]: unknown;
}

export interface BoardColumn {
  id: TaskStatus;
  title: string;
}

export interface AgentBoardFile {
  version: 1;
  columns: BoardColumn[];
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    priority: Priority;
    assignedAgent: AssignedAgent;
    qaAgent?: AssignedAgent;
    lastUpdated: string;
  }>;
  lastUpdated: string;
  [key: string]: unknown;
}

export interface ProjectInference {
  packageManager: string;
  scripts: string[];
  detectedFiles: string[];
  likelyStack: string[];
  suggestedValidation: string[];
  lastInferred: string;
  [key: string]: unknown;
}

export interface ProjectContext {
  version: 1;
  overview: string;
  goals: string[];
  architectureNotes: string;
  codingRules: string[];
  agentRules: string[];
  validationCommands: string[];
  designRules: string[];
  glossary: string[];
  inference: ProjectInference;
  lastUpdated: string;
  [key: string]: unknown;
}

export interface SaveTaskRequest {
  task: Partial<AgentBoardTask> & { id: string };
  expectedLastUpdated?: string;
}
