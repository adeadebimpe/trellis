import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clearAi, configureAi, configureSpecProvider, generateAgentSpecWithAi, getSpecProvider, resetAiSettings, setSpecProvider, specProviderLabel } from './ai';
import { chooseAgentSignIn, generateClaudeAutomationToken, signInClaudeCode, signInCodexCli } from './cliAuth';
import { deriveTaskTitle, getPrdSourceBrief } from './prdPrompt';
import { getWorkspaceStorage, StaleTaskError } from './storage';
import { AgentBoardTask, AssignedAgent } from './types';

let panel: vscode.WebviewPanel | undefined;
let sidebarView: vscode.WebviewView | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let activeStorage: Awaited<ReturnType<typeof getWorkspaceStorage>> | undefined;
let activeContext: vscode.ExtensionContext | undefined;
const ONBOARDING_COMPLETE_KEY = 'agentBoard.onboardingComplete';
const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext): void {
  activeContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand('agentBoard.openBoard', () => openBoard(context)),
    vscode.commands.registerCommand('agentBoard.configureAi', () => configureAi(context)),
    vscode.commands.registerCommand('agentBoard.clearAi', () => clearAi(context)),
    vscode.commands.registerCommand('agentBoard.configureSpecProvider', () => configureSpecProvider(context)),
    vscode.commands.registerCommand('agentBoard.signInAgents', () => chooseAgentSignIn()),
    vscode.commands.registerCommand('agentBoard.signInCodex', () => signInCodexCli()),
    vscode.commands.registerCommand('agentBoard.signInClaude', () => signInClaudeCode()),
    vscode.commands.registerCommand('agentBoard.setupClaudeToken', () => generateClaudeAutomationToken()),
    vscode.commands.registerCommand('agentBoard.freshStart', () => freshStart(context)),
    vscode.commands.registerCommand('agentBoard.prepareAgentFiles', async () => {
      const storage = await resolveStorage();
      await storage.prepareAgentFiles();
      vscode.window.showInformationMessage('Agent Board files are ready.');
      await postState();
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'agentBoard.boardView',
      {
        resolveWebviewView(view: vscode.WebviewView) {
          sidebarView = view;
          view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
          };
          view.webview.html = getHtml(view.webview, context.extensionUri);
          view.onDidDispose(() => {
            sidebarView = undefined;
          });
          view.webview.onDidReceiveMessage((message) => handleWebviewMessage(context, view.webview, message));
        }
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/.agent-board/**/*.json');
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(watcher);
}

export function deactivate(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
}

async function openBoard(context: vscode.ExtensionContext): Promise<void> {
  const storage = await resolveStorage();
  await storage.prepareAgentFiles();

  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    await postState();
    return;
  }

  panel = vscode.window.createWebviewPanel('agentBoard', 'Agent Board', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
  });

  panel.webview.html = getHtml(panel.webview, context.extensionUri);
  panel.onDidDispose(() => {
    panel = undefined;
  });

  const webview = panel.webview;
  webview.onDidReceiveMessage((message) => handleWebviewMessage(context, webview, message));

  await postState();
}

async function handleWebviewMessage(context: vscode.ExtensionContext, webview: vscode.Webview, message: any): Promise<void> {
  try {
    const storage = await resolveStorage();
    switch (message.type) {
      case 'ready':
        await postState();
        break;
      case 'create-task':
        const task = await storage.createTask();
        webview.postMessage({ type: 'select-task', id: task.id });
        await postState();
        break;
      case 'save-task':
        await storage.saveTask({ task: message.task, expectedLastUpdated: message.expectedLastUpdated });
        webview.postMessage({ type: 'saved', id: message.task.id });
        await postState();
        break;
      case 'move-task':
        await storage.moveTask(message.id, message.status, message.expectedLastUpdated);
        await postState();
        break;
      case 'delete-task':
        await storage.deleteTask(message.id);
        webview.postMessage({ type: 'task-deleted', id: message.id });
        await postState();
        break;
      case 'action':
        if (message.action === 'generate-spec') {
          const saved = message.task
            ? await storage.saveTask({ task: message.task, expectedLastUpdated: message.expectedLastUpdated })
            : undefined;
          await runGenerateSpecAction(context, message.id, saved?.lastUpdated ?? message.expectedLastUpdated);
        } else if (message.action === 'start-build') {
          const saved = message.task
            ? await storage.saveTask({ task: message.task, expectedLastUpdated: message.expectedLastUpdated })
            : undefined;
          await runStartBuildAction(message.id, saved?.lastUpdated ?? message.expectedLastUpdated);
        } else if (message.action === 'start-qa') {
          const saved = message.task
            ? await storage.saveTask({ task: message.task, expectedLastUpdated: message.expectedLastUpdated })
            : undefined;
          await runStartQaAction(message.id, saved?.lastUpdated ?? message.expectedLastUpdated);
        } else {
          await storage.runAction(message.id, message.action, message.expectedLastUpdated);
        }
        await postState();
        break;
      case 'save-project':
        await storage.saveProjectContext(message.project);
        webview.postMessage({ type: 'saved-project' });
        await postState();
        break;
      case 'infer-project':
        await storage.inferProjectContext();
        webview.postMessage({ type: 'saved-project' });
        await postState();
        break;
      case 'sign-in-agents':
        await chooseAgentSignIn();
        break;
      case 'sign-in-codex':
        await setSpecProvider(context, 'codex-cli');
        await context.globalState.update(ONBOARDING_COMPLETE_KEY, true);
        signInCodexCli();
        await postState();
        break;
      case 'sign-in-claude':
        await setSpecProvider(context, 'claude-code');
        await context.globalState.update(ONBOARDING_COMPLETE_KEY, true);
        signInClaudeCode();
        await postState();
        break;
      case 'configure-spec-provider':
        await configureSpecProvider(context);
        await postState();
        break;
      case 'continue-to-board':
        await context.globalState.update(ONBOARDING_COMPLETE_KEY, true);
        await postState();
        break;
      case 'open-full-board':
        await openBoard(context);
        break;
      case 'fresh-start':
        await freshStart(context);
        break;
    }
  } catch (error) {
    if (error instanceof StaleTaskError) {
      vscode.window.showWarningMessage(error.message);
      await postState();
      return;
    }
    const messageText = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(messageText);
    webview.postMessage({ type: 'error', message: messageText });
  }
}

async function runGenerateSpecAction(context: vscode.ExtensionContext, id: string, expectedLastUpdated?: string): Promise<void> {
  const storage = await resolveStorage();
  const state = await storage.loadBoardState();
  const task = state.tasks.find((item) => item.id === id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }
  if (!getPrdSourceBrief(task)) {
    vscode.window.showWarningMessage('Add your rough feature idea in the Brief field before generating a PRD.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Generating PRD...', cancellable: false },
    async () => {
      const provider = getSpecProvider(context);
      if (!provider) {
        vscode.window.showWarningMessage('Choose Codex, Claude, or OpenAI before generating a PRD.');
        return;
      }

      let aiPatch;
      try {
        aiPatch = await generateAgentSpecWithAi(context, task, state.project, storage.root.fsPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`${specProviderLabel(provider)} could not generate the PRD. Task was not changed. ${message}`);
        return;
      }
      if (!aiPatch) {
        vscode.window.showWarningMessage('PRD generation did not return a result. Task was not changed.');
        return;
      }
      await storage.saveTask({
        task: {
          id,
          title: task.title?.trim() || deriveTaskTitle(task),
          ...aiPatch,
          activityLog: [
            ...(task.activityLog ?? []),
            { timestamp: new Date().toISOString(), actor: provider, message: 'Generated PRD.' }
          ]
        },
        expectedLastUpdated
      }, provider);
    }
  );
}

async function runStartBuildAction(id: string, expectedLastUpdated?: string): Promise<void> {
  const storage = await resolveStorage();
  const state = await storage.loadBoardState();
  const task = findTask(state.tasks, id);
  const agent = requireAgent(task.assignedAgent, 'Assign Codex or Claude before starting build.');

  if (task.status !== 'ready-for-agent' && task.status !== 'building') {
    throw new Error('Move the task to Ready for Agent before starting build.');
  }

  await ensureAgentCliAvailable(agent);
  await runAgentBoardScript(storage.root.fsPath, ['.agent-board/scripts/claim-task.mjs', id, agent]);
  launchAgentTerminal(storage.root.fsPath, agent, buildImplementationPrompt(id));
  vscode.window.showInformationMessage(`${agentLabel(agent)} started building ${id} in a terminal.`);
  await postState();
}

async function runStartQaAction(id: string, expectedLastUpdated?: string): Promise<void> {
  const storage = await resolveStorage();
  const state = await storage.loadBoardState();
  const task = findTask(state.tasks, id);
  const agent = requireAgent(task.qaAgent, 'Assign a Codex or Claude QA agent before starting QA.');

  if (task.status !== 'ready-for-qa' && task.status !== 'failed-qa') {
    throw new Error('Move the task to Ready for QA before starting QA.');
  }

  await ensureAgentCliAvailable(agent);
  await runAgentBoardScript(storage.root.fsPath, ['.agent-board/scripts/start-qa.mjs', id, agent]);
  launchAgentTerminal(storage.root.fsPath, agent, buildQaPrompt(id));
  vscode.window.showInformationMessage(`${agentLabel(agent)} started QA for ${id} in a terminal.`);
  await postState();
}

function findTask(tasks: AgentBoardTask[], id: string): AgentBoardTask {
  const task = tasks.find((item) => item.id === id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }
  return task;
}

function requireAgent(agent: AssignedAgent, message: string): Exclude<AssignedAgent, 'unassigned'> {
  if (agent === 'claude' || agent === 'codex') {
    return agent;
  }
  throw new Error(message);
}

async function ensureAgentCliAvailable(agent: Exclude<AssignedAgent, 'unassigned'>): Promise<void> {
  const command = agentCommand(agent);
  try {
    await execFileAsync(command, ['--version'], { timeout: 10000 });
  } catch (error) {
    throw new Error(`${agentLabel(agent)} CLI is not available from VS Code. Sign in/install it first. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runAgentBoardScript(workspacePath: string, args: string[]): Promise<void> {
  try {
    await execFileAsync('node', args, { cwd: workspacePath, timeout: 20000 });
  } catch (error) {
    throw new Error(`Agent Board could not claim the task. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function launchAgentTerminal(workspacePath: string, agent: Exclude<AssignedAgent, 'unassigned'>, prompt: string): void {
  const terminal = vscode.window.createTerminal({ name: `Agent Board: ${agentLabel(agent)}`, cwd: workspacePath });
  terminal.show();
  terminal.sendText(agentLaunchCommand(agent, prompt));
}

function agentLaunchCommand(agent: Exclude<AssignedAgent, 'unassigned'>, prompt: string): string {
  if (agent === 'claude') {
    return `claude -p ${shellQuote(prompt)}`;
  }
  return `codex exec --skip-git-repo-check ${shellQuote(prompt)}`;
}

function buildImplementationPrompt(id: string): string {
  return [
    `You are the assigned implementation agent for Agent Board task ${id}.`,
    'Read .agent-board/project.json, .agent-board/board.json, and the matching .agent-board/tasks task JSON before editing.',
    'Implement only this task. Update relevantFiles, agentNotes, activityLog, and validation evidence as you work.',
    'Run the relevant validation commands. When implementation is complete, run: node .agent-board/scripts/complete-task.mjs ' + id,
    'If blocked, update the task with a blocker note and move it to human-review.'
  ].join('\n');
}

function buildQaPrompt(id: string): string {
  return [
    `You are the QA agent for Agent Board task ${id}.`,
    'Read .agent-board/project.json and the matching task JSON.',
    'Review acceptanceCriteria, qaChecklist, designQaChecklist, changed files, agentNotes, and validation evidence.',
    'Run the relevant validation or functional checks.',
    'If QA passes, run: node .agent-board/scripts/pass-qa.mjs ' + id + ' "QA passed."',
    'If QA fails, run: node .agent-board/scripts/fail-qa.mjs ' + id + ' "specific failure reason"'
  ].join('\n');
}

function agentCommand(agent: Exclude<AssignedAgent, 'unassigned'>): string {
  return agent === 'claude' ? 'claude' : 'codex';
}

function agentLabel(agent: Exclude<AssignedAgent, 'unassigned'>): string {
  return agent === 'claude' ? 'Claude Code' : 'Codex';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function freshStart(context: vscode.ExtensionContext): Promise<void> {
  const storage = await resolveStorage();
  const choice = await vscode.window.showWarningMessage(
    'Fresh start Agent Board?',
    { modal: true, detail: 'Reset setup only clears saved Agent Board provider/onboarding state. Reset board files also recreates .agent-board/ for this workspace.' },
    'Reset setup only',
    'Reset board files'
  );

  if (!choice) {
    return;
  }

  await resetAiSettings(context);
  await context.globalState.update(ONBOARDING_COMPLETE_KEY, undefined);

  if (choice === 'Reset board files') {
    await storage.resetBoardFiles();
    panel?.webview.postMessage({ type: 'fresh-started' });
    sidebarView?.webview.postMessage({ type: 'fresh-started' });
    vscode.window.showInformationMessage('Agent Board setup and .agent-board files were reset.');
  } else {
    vscode.window.showInformationMessage('Agent Board setup state was reset.');
  }

  await postState();
}

function scheduleRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    void postState();
  }, 150);
}

async function postState(): Promise<void> {
  const webviews = [panel?.webview, sidebarView?.webview].filter((view): view is vscode.Webview => Boolean(view));
  if (!webviews.length) {
    return;
  }
  const storage = await resolveStorage();
  const state = await storage.loadBoardState();
  const provider = activeContext ? getSpecProvider(activeContext) : undefined;
  const message = {
    type: 'state',
    state: {
      ...state,
      settings: {
        specProvider: provider,
        specProviderLabel: specProviderLabel(provider),
        setupComplete: Boolean(provider || activeContext?.globalState.get<boolean>(ONBOARDING_COMPLETE_KEY))
      }
    }
  };
  for (const webview of webviews) {
    webview.postMessage(message);
  }
}

async function resolveStorage(): Promise<Awaited<ReturnType<typeof getWorkspaceStorage>>> {
  if (activeStorage) {
    return activeStorage;
  }
  activeStorage = await getWorkspaceStorage();
  return activeStorage;
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.css'));
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Agent Board</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
