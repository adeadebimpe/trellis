import { AgentBoardTask, ProjectContext } from './types';

export interface AgentSpecPatch {
  title?: string;
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

export const TITLE_MAX_LENGTH = 60;

// Clip display titles at a word boundary, appending a single '…' so the result
// (ellipsis included) never exceeds maxLength. Falls back to a hard clip when
// the first word alone exceeds the budget.
export function clipTitle(text: string, maxLength = TITLE_MAX_LENGTH): string {
  const trimmed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  const budget = trimmed.slice(0, maxLength - 1);
  const lastSpace = budget.lastIndexOf(' ');
  const head = lastSpace > 0 ? budget.slice(0, lastSpace) : budget;
  return `${head.replace(/[\s.,;:!?…-]+$/g, '')}…`;
}

export function buildPrdPrompt(task: AgentBoardTask, project: ProjectContext): string {
  const userBrief = getPrdSourceBrief(task);
  const projectContext = compactObject({
    contextNotes: project.contextNotes,
    overview: isDefaultOverview(project.overview) ? '' : project.overview,
    goals: project.goals,
    architectureNotes: project.architectureNotes,
    codingRules: project.codingRules,
    agentRules: project.agentRules,
    validationCommands: project.validationCommands,
    designRules: project.designRules,
    glossary: project.glossary,
    inference: {
      packageManager: project.inference?.packageManager,
      scripts: project.inference?.scripts,
      detectedFiles: project.inference?.detectedFiles,
      likelyStack: project.inference?.likelyStack,
      suggestedValidation: project.inference?.suggestedValidation
    }
  });
  const input = compactObject({ userBrief, projectContext });
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
    '- Set title to a short, specific task name (max 60 characters, no trailing punctuation) that summarizes the userBrief.',
    '',
    'Return this exact JSON shape:',
    '{',
    '  "title": "string",',
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
    JSON.stringify(input, null, 2)
  ].join('\n');
}

const DEFAULT_PROJECT_OVERVIEW = 'Describe what this project does, who it serves, and the product constraints agents should understand before building tasks.';

function isDefaultOverview(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === DEFAULT_PROJECT_OVERVIEW;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const compacted = compactValue(entry);
    return compacted === undefined ? [] : [[key, compacted]];
  }));
}

function compactValue(value: unknown): unknown | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(value)) {
    const compacted = value.map(compactValue).filter((entry) => entry !== undefined);
    return compacted.length ? compacted : undefined;
  }
  if (value && typeof value === 'object') {
    const compacted = compactObject(value as Record<string, unknown>);
    return Object.keys(compacted).length ? compacted : undefined;
  }
  return value ?? undefined;
}

export function normalizeSpecPatch(value: Record<string, unknown>, task: AgentBoardTask, project: ProjectContext): AgentSpecPatch {
  const patch: AgentSpecPatch = {
    description: asString(value.description) || task.description,
    acceptanceCriteria: asStringArray(value.acceptanceCriteria, task.acceptanceCriteria),
    qaChecklist: asStringArray(value.qaChecklist, task.qaChecklist),
    designQaChecklist: asStringArray(value.designQaChecklist, task.designQaChecklist),
    validationCommands: asStringArray(value.validationCommands, task.validationCommands.length ? task.validationCommands : project.validationCommands),
    relevantFiles: asStringArray(value.relevantFiles, task.relevantFiles),
    constraints: asStringArray(value.constraints, task.constraints)
  };
  const title = asString(value.title).replace(/[.!?]+$/g, '').trim();
  if (title) {
    patch.title = clipTitle(title);
  }
  return patch;
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
  return clipTitle(cleaned) || task.id;
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
