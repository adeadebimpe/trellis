export const STANDARD_AGENT_PERMISSIONS = [
  'Bash(git branch:*)',
  'Bash(git checkout:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git merge:*)',
  'Bash(git worktree:*)',
  'Bash(node .agent-board/scripts/*)',
  'Bash(node */.agent-board/scripts/*)'
] as const;

export const CODEX_SCOPED_AUTOMATION_ARGS = ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'] as const;

export function codexAutomationArgs(enabled: boolean): string[] {
  return enabled ? [...CODEX_SCOPED_AUTOMATION_ARGS] : [];
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function codexLaunchCommand(promptPath: string, scopedAutomation: boolean): string {
  const globalArgs = codexAutomationArgs(scopedAutomation);
  return `codex${globalArgs.length ? ` ${globalArgs.join(' ')}` : ''} exec --skip-git-repo-check "$(cat ${posixQuote(promptPath)})"`;
}

const UNSAFE_COMMAND = /(^|(?:&&|\|\||;|\|)\s*)(?:sudo\s+)?(?:rm\b|git\s+(?:push\b|reset\s+--hard\b|clean\b)|(?:npm|pnpm|yarn)\s+publish\b)/i;

export function isSafeValidationCommand(command: string): boolean {
  const trimmed = command.trim();
  return Boolean(trimmed) && !trimmed.includes('\n') && !UNSAFE_COMMAND.test(trimmed);
}

export function buildAgentPermissionAllowlist(validationCommands: string[]): string[] {
  const validationPermissions = validationCommands
    .map((command) => command.trim())
    .filter(isSafeValidationCommand)
    .map((command) => `Bash(${command})`);
  return [...new Set([...STANDARD_AGENT_PERMISSIONS, ...validationPermissions])];
}

export interface ClaudeSettings {
  permissions?: {
    allow?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function mergeAgentPermissions(settings: ClaudeSettings, allowlist: string[]): ClaudeSettings {
  if (settings.permissions?.allow !== undefined && !Array.isArray(settings.permissions.allow)) {
    throw new Error('Cannot update .claude/settings.json because permissions.allow is not an array.');
  }
  const existing = Array.isArray(settings.permissions?.allow)
    ? settings.permissions.allow.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    ...settings,
    permissions: {
      ...settings.permissions,
      allow: [...new Set([...existing, ...allowlist])]
    }
  };
}

export function removeAgentPermissions(settings: ClaudeSettings, managed: string[]): ClaudeSettings {
  if (!Array.isArray(settings.permissions?.allow)) return settings;
  const managedSet = new Set(managed);
  return {
    ...settings,
    permissions: {
      ...settings.permissions,
      allow: settings.permissions.allow.filter((entry) => typeof entry !== 'string' || !managedSet.has(entry))
    }
  };
}

export function hasAgentPermissions(settings: ClaudeSettings, allowlist: string[]): boolean {
  const allowed = new Set(Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : []);
  return allowlist.every((entry) => allowed.has(entry));
}
