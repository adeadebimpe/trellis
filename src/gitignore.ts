const TRELLIS_IGNORE_ENTRY = '.trellis/';

export function hasTrellisIgnore(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const pattern = line.trim();
    return pattern === '.trellis'
      || pattern === '.trellis/'
      || pattern === '/.trellis'
      || pattern === '/.trellis/';
  });
}

export function ensureTrellisIgnore(content: string): string {
  if (hasTrellisIgnore(content)) {
    return content;
  }
  if (!content) {
    return `${TRELLIS_IGNORE_ENTRY}\n`;
  }
  const separator = content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}${TRELLIS_IGNORE_ENTRY}\n`;
}
