export type PendingIntake = {
  requestId: string;
  summary: string;
  state: 'queued' | 'drafting' | 'done' | 'error';
  taskId?: string;
  message?: string;
};

export function queueIntake(items: PendingIntake[], requestId: string, text: string): PendingIntake[] {
  const summary = text.length > 80 ? `${text.slice(0, 77)}…` : text;
  return [{ requestId, summary, state: 'queued' } satisfies PendingIntake, ...items].slice(0, 8);
}

export function updateIntake(
  items: PendingIntake[],
  requestId: string,
  patch: Partial<Omit<PendingIntake, 'requestId' | 'summary'>>
): PendingIntake[] {
  return items.map((item) => item.requestId === requestId ? { ...item, ...patch } : item);
}

export function dismissIntake(items: PendingIntake[], requestId: string): PendingIntake[] {
  return items.filter((item) => item.requestId !== requestId);
}
