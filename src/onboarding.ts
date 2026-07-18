export function isSetupComplete(
  specProviderConfigured: boolean,
  onboardingComplete: boolean,
  availableAgentCount: number
): boolean {
  return specProviderConfigured || onboardingComplete || availableAgentCount > 0;
}
