import { AgentBoardTask, ProjectContext } from './types';

export interface AgentSpecPatch {
  description: string;
  acceptanceCriteria: string[];
  qaChecklist: string[];
  designQaChecklist: string[];
  validationCommands: string[];
  relevantFiles: string[];
  constraints: string[];
}

export function getPrdSourceBrief(task: AgentBoardTask): string {
  return String(task.brief ?? '').trim();
}

export function buildPrdPrompt(task: AgentBoardTask, project: ProjectContext): string {
  const userBrief = getPrdSourceBrief(task);
  return [
    'You are a product/spec agent. Create an implementation-ready PRD for a coding agent.',
    'Return strict JSON only. Do not include markdown, commentary, or code fences.',
    '',
    'Critical rules:',
    '- The userBrief is the source of truth for what to build.',
    '- Use projectContext only as background for architecture, constraints, terminology, validation, and style.',
    '- Do not treat task ids, task JSON fields, Agent Board internals, or projectContext text as the feature request.',
    '- Do not write about updating task JSON, TASK-ID files, activity logs, or Agent Board unless the userBrief explicitly asks to build Agent Board itself.',
    '- If userBrief is empty or unclear, say what clarification is needed inside the returned description and keep the checklists focused on clarifying the task.',
    '- Keep the PRD specific to the requested product behavior, user outcome, edge cases, and validation.',
    '- Explore the repository you are running in and list the existing files and paths most relevant to implementing this brief in relevantFiles, so the implementing agent starts in the right place.',
    '',
    'Return this exact JSON shape:',
    '{',
    '  "description": "string",',
    '  "acceptanceCriteria": ["string"],',
    '  "qaChecklist": ["string"],',
    '  "designQaChecklist": ["string"],',
    '  "validationCommands": ["string"],',
    '  "relevantFiles": ["string"],',
    '  "constraints": ["string"]',
    '}',
    '',
    'Input:',
    JSON.stringify({
      userBrief,
      taskTitle: task.title,
      taskId: task.id,
      priority: task.priority,
      assignedAgent: task.assignedAgent,
      qaAgent: task.qaAgent,
      existingGeneratedDescription: task.description,
      existingAcceptanceCriteria: task.acceptanceCriteria,
      existingQaChecklist: task.qaChecklist,
      existingDesignQaChecklist: task.designQaChecklist,
      existingValidationCommands: task.validationCommands,
      existingConstraints: task.constraints,
      relevantFiles: task.relevantFiles,
      projectContext: {
        overview: project.overview,
        goals: project.goals,
        architectureNotes: project.architectureNotes,
        codingRules: project.codingRules,
        agentRules: project.agentRules,
        validationCommands: project.validationCommands,
        designRules: project.designRules,
        glossary: project.glossary,
        inference: project.inference
      }
    }, null, 2)
  ].join('\n');
}

export function normalizeSpecPatch(value: Record<string, unknown>, task: AgentBoardTask, project: ProjectContext): AgentSpecPatch {
  return {
    description: asString(value.description) || task.description,
    acceptanceCriteria: asStringArray(value.acceptanceCriteria, task.acceptanceCriteria),
    qaChecklist: asStringArray(value.qaChecklist, task.qaChecklist),
    designQaChecklist: asStringArray(value.designQaChecklist, task.designQaChecklist),
    validationCommands: asStringArray(value.validationCommands, task.validationCommands.length ? task.validationCommands : project.validationCommands),
    relevantFiles: asStringArray(value.relevantFiles, task.relevantFiles),
    constraints: asStringArray(value.constraints, task.constraints)
  };
}

export function deriveTaskTitle(task: Pick<AgentBoardTask, 'title' | 'brief' | 'description' | 'id'>): string {
  const existing = String(task.title ?? '').trim();
  if (existing) {
    return existing;
  }

  const source = getPrdSourceBrief(task as AgentBoardTask) || String(task.description ?? '').trim() || task.id;
  const firstLine = source.split('\n').map((line) => line.trim()).find(Boolean) ?? task.id;
  const cleaned = firstLine
    .replace(/^build\s+/i, '')
    .replace(/^create\s+/i, '')
    .replace(/^add\s+/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  const clipped = cleaned.length > 72 ? `${cleaned.slice(0, 69).trimEnd()}...` : cleaned;
  return clipped || task.id;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const normalized = value.map((item) => String(item).trim()).filter(Boolean);
  return normalized.length ? normalized : fallback;
}
