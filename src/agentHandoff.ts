export type RegisteredAgentKind = 'build' | 'qa' | undefined;
export type ExecutionSurface = 'chat' | 'terminal';

export interface RegisteredTerminal {
  taskId: string;
  kind: Exclude<RegisteredAgentKind, undefined>;
}

export function terminalStartBlockReason(
  taskId: string,
  kind: Exclude<RegisteredAgentKind, undefined>,
  registered: RegisteredTerminal[]
): string | undefined {
  if (registered.some((entry) => entry.taskId === taskId)) {
    return `${taskId} already has an active Trellis terminal. Use Show terminal to return to it.`;
  }
  if (kind === 'build' && registered.some((entry) => entry.kind === 'build')) {
    return 'Another build is already running. Trellis runs builds one at a time and will start the next ready task when it finishes.';
  }
  return undefined;
}

export interface TerminalOwnership {
  claimId: string;
  phase: Exclude<RegisteredAgentKind, undefined>;
  completedSuccessfully?: boolean;
}

export interface ActiveRun {
  claimId: string;
  phase: Exclude<RegisteredAgentKind, undefined>;
  agent: 'codex' | 'claude';
  surface: ExecutionSurface;
  startedAt: string;
}

export function activeRunBlockReason(
  taskId: string,
  requestedPhase: Exclude<RegisteredAgentKind, undefined>,
  run: ActiveRun | undefined
): string | undefined {
  if (!run) return undefined;
  const phase = run.phase === 'qa' ? 'QA' : 'Build';
  const surface = run.surface === 'chat' ? 'chat' : 'a Trellis terminal';
  return `${taskId} already has ${phase} running with ${run.agent} in ${surface}. Return to that session instead of starting another ${requestedPhase}.`;
}

export function isTerminalOwnedHandoff(
  ownership: TerminalOwnership | undefined,
  claimId: string | undefined,
  phase: Exclude<RegisteredAgentKind, undefined>
): boolean {
  return Boolean(claimId)
    && ownership?.claimId === claimId
    && ownership?.phase === phase
    && ownership.completedSuccessfully === true;
}

export function shouldStartAutomaticQa(
  status: string,
  registeredKind: RegisteredAgentKind,
  starting: boolean,
  attemptedVersion: string | undefined,
  currentVersion: string
): boolean {
  return status === 'ready-for-qa'
    && registeredKind === undefined
    && !starting
    && attemptedVersion !== currentVersion;
}
