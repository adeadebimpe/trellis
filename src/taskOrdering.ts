type TaskRecency = {
  id: string;
  lastUpdated: string;
};

export function compareTasksByLatestUpdate(a: TaskRecency, b: TaskRecency): number {
  const aTimestamp = Date.parse(a.lastUpdated);
  const bTimestamp = Date.parse(b.lastUpdated);
  const aIsValid = Number.isFinite(aTimestamp);
  const bIsValid = Number.isFinite(bTimestamp);

  if (aIsValid && bIsValid && aTimestamp !== bTimestamp) {
    return bTimestamp - aTimestamp;
  }

  if (aIsValid !== bIsValid) {
    return aIsValid ? -1 : 1;
  }

  return a.id.localeCompare(b.id);
}
