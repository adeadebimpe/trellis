export type RegisteredAgentKind = 'build' | 'qa' | undefined;

export interface TerminalOwnership {
  claimId: string;
  phase: Exclude<RegisteredAgentKind, undefined>;
}

export function isTerminalOwnedHandoff(
  ownership: TerminalOwnership | undefined,
  claimId: string | undefined,
  phase: Exclude<RegisteredAgentKind, undefined>
): boolean {
  return Boolean(claimId)
    && ownership?.claimId === claimId
    && ownership?.phase === phase;
}

export function shouldStartAutomaticQa(
  status: string,
  registeredKind: RegisteredAgentKind,
  starting: boolean,
  attemptedVersion: string | undefined,
  currentVersion: string
): boolean {
  return status === 'ready-for-qa'
    && registeredKind !== 'qa'
    && !starting
    && attemptedVersion !== currentVersion;
}
