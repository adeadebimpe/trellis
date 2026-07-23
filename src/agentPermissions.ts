export const STANDARD_AGENT_PERMISSIONS = [
  'Bash(git branch:*)',
  'Bash(git checkout:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git merge:*)',
  'Bash(git worktree:*)',
  'Bash(node .trellis/scripts/*)',
  'Bash(node */.trellis/scripts/*)'
] as const;

export const CODEX_SCOPED_AUTOMATION_ARGS = ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'] as const;

export function codexAutomationArgs(enabled: boolean, scope?: ClaudeAutomationScope): string[] {
  if (!enabled) return [];
  const args: string[] = [...CODEX_SCOPED_AUTOMATION_ARGS];
  if (scope) {
    const mainRoot = scope.mainRoot.replace(/\/+$/, '');
    const boardRoot = `${mainRoot}/.trellis`;
    args.push('--add-dir', `${mainRoot}/.git`, '--add-dir', `${boardRoot}/tasks`, '--add-dir', `${boardRoot}/locks`);
  }
  return args;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function codexLaunchCommand(promptPath: string, scopedAutomation: boolean, scope?: ClaudeAutomationScope): string {
  const globalArgs = codexAutomationArgs(scopedAutomation, scope);
  return `codex${globalArgs.length ? ` ${globalArgs.join(' ')}` : ''} exec --skip-git-repo-check "$(cat ${posixQuote(promptPath)})"`;
}

const UNSAFE_COMMAND = /(^|(?:&&|\|\||;|\|)\s*)(?:sudo\s+)?(?:rm\b|git\s+(?:push\b|reset\s+--hard\b|clean\b)|(?:npm|pnpm|yarn)\s+publish\b)/i;

export interface ClaudeAutomationScope {
  worktreePath: string;
  mainRoot: string;
  taskId: string;
}

export function claudeAutomationArgs(
  enabled: boolean,
  managedAllowlist: string[],
  scope: ClaudeAutomationScope
): string[] {
  if (!enabled) return [];
  const worktree = scope.worktreePath.replace(/\/+$/, '');
  const taskRecord = `${scope.mainRoot.replace(/\/+$/, '')}/.trellis/tasks/${scope.taskId}.json`;
  const safeManaged = managedAllowlist.filter((permission) => {
    if (!permission.startsWith('Bash(') || !permission.endsWith(')')) return false;
    return !UNSAFE_COMMAND.test(permission.slice(5, -1));
  });
  const allowedTools = [
    `Read(${taskRecord})`,
    `Edit(${taskRecord})`,
    `Write(${taskRecord})`,
    `Edit(${worktree}/**)`,
    `Write(${worktree}/**)`,
    ...safeManaged
  ];
  return ['--add-dir', scope.mainRoot, '--allowedTools', ...new Set(allowedTools)];
}

export function claudeLaunchCommand(promptPath: string, automationArgs: string[]): string {
  const args = automationArgs.length ? ` ${automationArgs.map(posixQuote).join(' ')}` : '';
  return `claude -p${args} "$(cat ${posixQuote(promptPath)})"`;
}

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
