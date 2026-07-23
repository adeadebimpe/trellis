type Identified = { id: string };

export function mergeSpecialistDrafts<T extends Identified>(
  specialists: T[],
  drafts: T[],
  errors: Record<string, object>
): T[] {
  const draftsById = new Map(drafts.map((draft) => [draft.id, draft]));
  const hasErrors = (id: string): boolean => Object.keys(errors[id] ?? {}).length > 0;
  const merged = specialists.map((specialist) => (
    hasErrors(specialist.id) ? draftsById.get(specialist.id) ?? specialist : specialist
  ));
  const persistedIds = new Set(specialists.map((specialist) => specialist.id));
  return [...merged, ...drafts.filter((draft) => !persistedIds.has(draft.id) && hasErrors(draft.id))];
}
