import { AgentBoardTask, ProjectContext } from './types';

export interface AgentSpecPatch {
  description: string;
  acceptanceCriteria: string[];
  qaChecklist: string[];
  designQaChecklist: string[];
  validationCommands: string[];
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
    '',
    'Return this exact JSON shape:',
    '{',
    '  "description": "string",',
    '  "acceptanceCriteria": ["string"],',
    '  "qaChecklist": ["string"],',
    '  "designQaChecklist": ["string"],',
    '  "validationCommands": ["string"],',
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
    constraints: asStringArray(value.constraints, task.constraints)
  };
}

export function buildLocalPrdPatch(task: AgentBoardTask, project: ProjectContext): AgentSpecPatch {
  const brief = getPrdSourceBrief(task);
  const title = deriveTaskTitle(task);
  const validationCommands = uniqueStrings([
    ...task.validationCommands,
    ...project.validationCommands,
    ...project.inference.suggestedValidation
  ]);
  const constraints = uniqueStrings([
    ...task.constraints,
    ...project.codingRules.slice(0, 4),
    ...project.designRules.slice(0, 3),
    'Keep the implementation scoped to this task.',
    'Preserve existing user and agent changes outside the task scope.'
  ]);

  return {
    description: [
      `Build ${title}.`,
      '',
      brief || 'The task brief is empty. Clarify the user outcome before implementation starts.',
      '',
      'Use the project context as background for architecture, coding rules, validation commands, and design expectations. The implementing agent should inspect the relevant code paths, make the smallest complete change, update the task with changed files and notes, and run the relevant validation before handoff.'
    ].join('\n'),
    acceptanceCriteria: task.acceptanceCriteria.length ? task.acceptanceCriteria : [
      `${title} is implemented in the appropriate product surface or code path.`,
      'The behavior matches the task brief and does not introduce unrelated workflow changes.',
      'Empty, loading, error, and long-content states are handled where the workflow can encounter them.',
      'The selected agent can claim or continue the task using the repo-native Agent Board files.',
      'Relevant files, agent notes, and activity history are updated before QA handoff.'
    ],
    qaChecklist: task.qaChecklist.length ? task.qaChecklist : [
      'Open the Agent Board extension and exercise the task workflow from brief entry through PRD generation.',
      'Verify generated task fields are populated and readable in the board drawer.',
      'Assign Codex or Claude to the task and confirm the assignment persists after refresh.',
      'Move the task through ready-for-agent, building, and ready-for-qa and confirm the task JSON stays in sync.',
      'Run the project validation commands that apply to the changed files.'
    ],
    designQaChecklist: task.designQaChecklist.length ? task.designQaChecklist : [
      'Confirm the task creation and PRD controls are visible without hunting through secondary UI.',
      'Check the board remains dense, scannable, and operational rather than marketing-like.',
      'Verify generated text, task cards, and drawer fields do not overlap or clip at narrow and wide editor widths.',
      'Confirm sign-in and provider state are understandable from the board header or setup surface.'
    ],
    validationCommands: validationCommands.length ? validationCommands : ['npm run compile'],
    constraints
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

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value).trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
