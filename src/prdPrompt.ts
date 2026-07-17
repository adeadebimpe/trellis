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

export function buildPrdPrompt(task: AgentBoardTask, project: ProjectContext): string {
  const userBrief = getPrdSourceBrief(task);
  const mode = project.contextMode ?? 'standard';
  const commonContext = {
    codingRules: project.codingRules,
    agentRules: project.agentRules,
    validationCommands: project.validationCommands,
    designRules: project.designRules,
    relevantFiles: project.inference?.detectedFiles,
    contextProfiles: selectProfiles(project.contextProfiles, userBrief, mode)
  };
  const summaryContext = {
    contextNotes: project.contextNotes,
    overview: isDefaultOverview(project.overview) ? '' : project.overview,
    goals: project.goals,
    architectureNotes: project.architectureNotes,
    glossary: project.glossary,
    inference: {
      packageManager: project.inference?.packageManager,
      scripts: project.inference?.scripts,
      likelyStack: project.inference?.likelyStack,
      suggestedValidation: project.inference?.suggestedValidation
    }
  };
  const projectContext = limitObject(compactObject(mode === 'lean'
    ? commonContext
    : { ...summaryContext, ...commonContext }));
  const input = compactObject({ userBrief: limitString(userBrief, 4000), contextMode: mode, projectContext });
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
    '- Set title to a short, specific task name (max 72 characters, no trailing punctuation) that summarizes the userBrief.',
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

function selectProfiles(
  profiles: ProjectContext['contextProfiles'],
  brief: string,
  mode: ProjectContext['contextMode']
): ProjectContext['contextProfiles'] {
  if (!profiles) return {};
  if (mode === 'full') return profiles;
  const source = brief.toLowerCase();
  const selected: ProjectContext['contextProfiles'] = {};
  if (/\b(ui|ux|frontend|webview|react|css|component|page|sidebar|drawer)\b/.test(source)) selected.frontend = profiles.frontend;
  if (/\b(api|backend|server|database|storage|endpoint|service)\b/.test(source)) selected.backend = profiles.backend;
  if (/\b(infra|infrastructure|deploy|ci|cd|docker|cloud|pipeline|terraform)\b/.test(source)) selected.infrastructure = profiles.infrastructure;
  return selected;
}

function limitObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, limitValue(entry)]));
}

function limitValue(value: unknown): unknown {
  if (typeof value === 'string') return limitString(value, 1200);
  if (Array.isArray(value)) return value.slice(0, 12).map((entry) => typeof entry === 'string' ? limitString(entry, 240) : limitValue(entry));
  if (value && typeof value === 'object') return limitObject(value as Record<string, unknown>);
  return value;
}

function limitString(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
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
    patch.title = title.length > 72 ? `${title.slice(0, 69).trimEnd()}...` : title;
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
