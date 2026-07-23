export function generatedTaskBranchName(id: string, title: string): string {
  const slug = String(title || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
  return `agent-board/${id}-${slug}`;
}

export function branchNameValidationError(value: string): string {
  if (!value) return '';
  if (value.trim() !== value) return 'Branch names cannot start or end with whitespace.';
  if (value.startsWith('-')) return 'Branch names cannot start with a dash.';
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
    return 'Branch names cannot start or end with “/”, or contain consecutive slashes.';
  }
  if (value.endsWith('.') || value.includes('..')) {
    return 'Branch names cannot end with a dot or contain “..”.';
  }
  if (value.endsWith('.lock')) return 'Branch names cannot end with “.lock”.';
  if (value.includes('@{')) return 'Branch names cannot contain “@{”.';
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(value)) {
    return 'Branch names cannot contain spaces, control characters, or any of: ~ ^ : ? * [ \\';
  }
  if (value === '@') return '“@” is not a valid branch name.';
  if (value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    return 'Each branch-name segment must be non-empty, cannot start with a dot, and cannot end with “.lock”.';
  }
  return '';
}
