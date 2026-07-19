export type RegisteredAgentKind = 'build' | 'qa' | undefined;

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
