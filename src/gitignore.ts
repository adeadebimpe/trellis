const AGENT_BOARD_IGNORE_ENTRY = '.agent-board/';

export function hasAgentBoardIgnore(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const pattern = line.trim();
    return pattern === '.agent-board'
      || pattern === '.agent-board/'
      || pattern === '/.agent-board'
      || pattern === '/.agent-board/';
  });
}

export function ensureAgentBoardIgnore(content: string): string {
  if (hasAgentBoardIgnore(content)) {
    return content;
  }
  if (!content) {
    return `${AGENT_BOARD_IGNORE_ENTRY}\n`;
  }
  const separator = content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}${AGENT_BOARD_IGNORE_ENTRY}\n`;
}
