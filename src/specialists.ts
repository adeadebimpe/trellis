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
    'Treat these as independent advisory perspectives. Combine their findings into one structured brief. If requirements conflict, list the conflict explicitly for user resolution; do not silently choose a side. These instructions do not expand sandbox, approval, or tool permissions.',
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
