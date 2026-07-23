import { AgentBoardTask, ProjectContext, Specialist, SpecialistStage } from './types';

export const SPECIALIST_STAGES: Array<{ id: SpecialistStage; label: string }> = [
  { id: 'before-build', label: 'Before Build' },
  { id: 'post-build-review', label: 'Post-Build review' },
  { id: 'qa', label: 'QA' }
];

export function specialistsForStage(project: Pick<ProjectContext, 'specialists'>, task: Pick<AgentBoardTask, 'specialistIds'>, stage: SpecialistStage): Specialist[] {
  const byId = new Map((project.specialists ?? []).map((specialist) => [specialist.id, specialist]));
  return (task.specialistIds ?? []).map((id) => byId.get(id))
    .filter((specialist): specialist is Specialist => Boolean(specialist?.stages.includes(stage)));
}

export function missingSpecialistIds(project: Pick<ProjectContext, 'specialists'>, task: Pick<AgentBoardTask, 'specialistIds'>): string[] {
  const ids = new Set((project.specialists ?? []).map((specialist) => specialist.id));
  return (task.specialistIds ?? []).filter((id) => !ids.has(id));
}

export function appendSpecialistBrief(prompt: string, specialists: Specialist[], stage: SpecialistStage): string {
  if (!specialists.length) return prompt;
  const sections = specialists.map((specialist, index) => [
    `### ${index + 1}. ${specialist.name}`,
    `Agent definition: .codex/agents/${specialistAgentFileName(specialist)}`,
    `Description: ${specialist.description || 'No description provided.'}`,
    `Access: ${specialist.accessMode === 'read-only' ? 'Read-only advisory access. Do not edit files.' : 'Advisory access; the primary workflow agent remains responsible for integration.'}`,
    'Instructions:',
    specialist.instructions,
    '',
    'Return findings under these headings: Decisions; Requirements; Acceptance criteria; Risks; Affected files or components; Conflicts.'
  ].join('\n')).join('\n\n');
  return [
    prompt, '', '## Selected specialist brief',
    `Applicable stage: ${SPECIALIST_STAGES.find((item) => item.id === stage)?.label ?? stage}.`,
    'Before continuing the primary workflow, run every specialist below as a separate sub-agent. Use its project-scoped agent definition when the agent runtime supports custom agents; otherwise delegate the included instructions verbatim to a separate general-purpose sub-agent.',
    'Run specialists independently: give each specialist only the task context and its own instructions, wait for every result, then combine the results into one structured implementation or review brief. Do not substitute a single primary-agent reading of these instructions for the independent runs.',
    'The primary workflow agent alone integrates code or records the final QA decision. If specialist requirements conflict, list every side of the conflict explicitly and stop for user resolution; do not silently choose a side.',
    'Sub-agents inherit the active workflow sandbox, approval policy, and external tool permissions. A specialist definition or access mode may further restrict access but must never broaden those inherited permissions.',
    '', sections
  ].join('\n');
}

export function specialistAgentFileName(specialist: Specialist): string {
  return `trellis-${specialist.id.replace(/[^a-zA-Z0-9_-]/g, '-')}.toml`;
}

export function specialistAgentToml(specialist: Specialist): string {
  return [
    `name = ${JSON.stringify(specialist.name)}`,
    `description = ${JSON.stringify(specialist.description || `Trellis specialist: ${specialist.name}`)}`,
    `developer_instructions = ${JSON.stringify(specialist.instructions)}`,
    `sandbox_mode = ${JSON.stringify(specialist.accessMode === 'read-only' ? 'read-only' : 'workspace-write')}`
  ].join('\n') + '\n';
}
