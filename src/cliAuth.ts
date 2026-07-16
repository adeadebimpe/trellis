import * as vscode from 'vscode';

export type AgentCli = 'codex' | 'claude';

export function signInCodexCli(): void {
  const terminal = getTerminal('Agent Board: Codex Sign In');
  terminal.show();
  terminal.sendText('codex');
  vscode.window.showInformationMessage('Codex sign-in opened in the terminal. If prompted, sign in with ChatGPT or an API key.');
}

export function signInClaudeCode(): void {
  const terminal = getTerminal('Agent Board: Claude Sign In');
  terminal.show();
  terminal.sendText('claude auth login');
  vscode.window.showInformationMessage('Claude Code sign-in opened in the terminal. Complete the browser login or paste the returned code if prompted.');
}

export function generateClaudeAutomationToken(): void {
  const terminal = getTerminal('Agent Board: Claude Token');
  terminal.show();
  terminal.sendText('claude setup-token');
  vscode.window.showInformationMessage('Claude Code token setup opened in the terminal. Store the token only where you intentionally want automation to run.');
}

export async function chooseAgentSignIn(): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: 'Sign in to Codex CLI',
        description: 'Runs codex so the official CLI can start its own sign-in flow',
        value: 'codex'
      },
      {
        label: 'Sign in to Claude Code',
        description: 'Runs claude auth login for the official Claude Code OAuth flow',
        value: 'claude'
      },
      {
        label: 'Generate Claude automation token',
        description: 'Runs claude setup-token for CI/script usage',
        value: 'claude-token'
      }
    ],
    { title: 'Agent Board Sign In' }
  );

  if (choice?.value === 'codex') {
    signInCodexCli();
  }
  if (choice?.value === 'claude') {
    signInClaudeCode();
  }
  if (choice?.value === 'claude-token') {
    generateClaudeAutomationToken();
  }
}

function getTerminal(name: string): vscode.Terminal {
  return vscode.window.terminals.find((terminal) => terminal.name === name) ?? vscode.window.createTerminal({ name });
}
