const TASK_ID_PATTERN = /^TASK-\d{3,}$/;

export function assertTaskId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    throw new Error(`Invalid task ID: ${String(value)}. Expected TASK followed by at least three digits.`);
  }
}

export function assertTaskLockKey(value: string): void {
  if (value !== '_board') assertTaskId(value);
}
