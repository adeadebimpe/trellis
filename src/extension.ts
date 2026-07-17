import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clearAi, configureAi, configureSpecProvider, generateAgentSpecWithAi, getSpecProvider, resetAiSettings, setSpecProvider, specProviderLabel } from './ai';
import { chooseAgentSignIn, generateClaudeAutomationToken, signInClaudeCode, signInCodexCli } from './cliAuth';
import { shipTask } from './ship';
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

type AgentKind = 'build' | 'qa';
const agentTerminals = new Map<string, { terminal: vscode.Terminal; kind: AgentKind }>();
const TERMINAL_NAME_PATTERN = /^Agent Board: (\S+) (build|qa) /;
const autoQaStarting = new Set<string>();
const autoQaAttemptedVersions = new Map<string, string>();
const autoRepairStarting = new Set<string>();
const autoRepairAttemptedVersions = new Map<string, string>();
const autoBuildStarting = new Set<string>();
const autoBuildAttemptedVersions = new Map<string, string>();

type CliAgent = Exclude<AssignedAgent, 'unassigned'>;
let detectedAgentsPromise: Promise<CliAgent[]> | undefined;

function detectAvailableAgents(force = false): Promise<CliAgent[]> {
  if (!detectedAgentsPromise || force) {
    detectedAgentsPromise = Promise.all(
      (['claude', 'codex'] as const).map((agent) =>
        execFileAsync(agent, ['--version'], { timeout: 10000 }).then(() => agent, () => undefined)
      )
    ).then((results) => results.filter((agent): agent is CliAgent => Boolean(agent)));
  }
  return detectedAgentsPromise;
}

async function pickAutoAgent(): Promise<AssignedAgent> {
  const available = await detectAvailableAgents();
  const provider = activeContext ? getSpecProvider(activeContext) : undefined;
  const preferred = provider === 'codex-cli' ? 'codex' : provider === 'claude-code' ? 'claude' : undefined;
  if (preferred && available.includes(preferred)) {
    return preferred;
  }
  return available[0] ?? 'unassigned';
}

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

  // Anchored so JSON inside .agent-board/worktrees/* checkouts never triggers refreshes.
  const folder = vscode.workspace.workspaceFolders?.[0];
  const watcher = vscode.workspace.createFileSystemWatcher(
    folder
      ? new vscode.RelativePattern(folder, '.agent-board/{tasks/*.json,project.json}')
      : '**/.agent-board/{tasks/*.json,project.json}'
  );
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(watcher);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('agentBoard.autoContinue')) scheduleRefresh();
  }));

  // Reclaim terminals from a previous extension-host session by name.
  for (const terminal of vscode.window.terminals) {
    const match = TERMINAL_NAME_PATTERN.exec(terminal.name);
    if (match) {
      agentTerminals.set(match[1], { terminal, kind: match[2] as AgentKind });
    }
  }

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(async (terminal) => {
      for (const [taskId, entry] of agentTerminals) {
        if (entry.terminal === terminal) {
          agentTerminals.delete(taskId);
          await handleAgentTerminalClosed(taskId, entry.kind);
          break;
        }
      }
    })
  );

  // Resume the automatic handoff for tasks that became QA-ready while the
  // extension host was stopped. Existing QA terminals are reclaimed above.
  void refreshBoard();
}

async function handleAgentTerminalClosed(taskId: string, kind: AgentKind): Promise<void> {
  try {
    const storage = await resolveStorage();
    const state = await storage.loadBoardState();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    const interrupted = (kind === 'build' && task.status === 'building') || (kind === 'qa' && task.status === 'qa-running');
    if (!interrupted) {
      return;
    }
    const now = new Date().toISOString();
    await storage.saveTask({
      task: {
        id: taskId,
        status: 'human-review',
        activityLog: [
          ...(task.activityLog ?? []),
          { timestamp: now, actor: 'vscode', message: `Agent terminal closed while task was ${task.status}. Moved to human-review for follow-up.` }
        ]
      }
    });
    vscode.window.showWarningMessage(`Agent terminal for ${taskId} closed while it was ${task.status}. The task was moved to Human Review.`);
    await postState();
  } catch (error) {
    console.error('Agent Board: failed to handle closed agent terminal', error);
  }
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
      case 'create-task': {
        const brief = String(message.brief ?? '').trim();
        const autoAgent = await pickAutoAgent();
        const task = await storage.createTask(brief
          ? { brief, assignedAgent: autoAgent, qaAgent: autoAgent }
          : undefined);
        webview.postMessage({ type: 'select-task', id: task.id });
        await postState();
        if (brief) {
          await runGenerateSpecAction(context, task.id, task.lastUpdated);
          await postState();
        }
        break;
      }
      case 'save-task':
        await storage.saveTask({ task: message.task, expectedLastUpdated: message.expectedLastUpdated });
        webview.postMessage({ type: 'saved', id: message.task.id });
        await postState();
        break;
      case 'move-task':
        await storage.moveTask(message.id, message.status, message.expectedLastUpdated);
        await postState();
        break;
      case 'request-changes': {
        const feedback = String(message.feedback ?? '').trim();
        if (!feedback) {
          throw new Error('Add a review comment before sending the task back to Building.');
        }
        const current = findTask((await storage.loadBoardState()).tasks, message.id);
        if (current.status !== 'human-review') {
          throw new Error('Only tasks in Human Review can be sent back to Building.');
        }
        const now = new Date().toISOString();
        await storage.saveTask({
          task: {
            id: current.id,
            status: 'building',
            activityLog: [
              ...(current.activityLog ?? []),
              { timestamp: now, actor: 'human-review', message: `Changes requested: ${feedback}` }
            ]
          },
          expectedLastUpdated: message.expectedLastUpdated
        });
        await runStartBuildAction(current.id);
        webview.postMessage({ type: 'review-feedback-sent', id: current.id });
        await postState();
        break;
      }
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
          if (message.task) {
            await storage.saveTask({ task: message.task, expectedLastUpdated: message.expectedLastUpdated });
          }
          await runStartBuildAction(message.id);
        } else if (message.action === 'start-qa') {
          if (message.task) {
            await storage.saveTask({ task: message.task, expectedLastUpdated: message.expectedLastUpdated });
          }
          await runStartQaAction(message.id);
        } else {
          const saved = message.task
            ? await storage.saveTask({ task: message.task, expectedLastUpdated: message.expectedLastUpdated })
            : undefined;
          await storage.runAction(message.id, message.action, saved?.lastUpdated ?? message.expectedLastUpdated);
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
        await detectAvailableAgents(true);
        await postState();
        webview.postMessage({ type: 'open-project-context', project: (await storage.loadBoardState()).project });
        break;
      case 'sign-in-claude':
        await setSpecProvider(context, 'claude-code');
        await context.globalState.update(ONBOARDING_COMPLETE_KEY, true);
        signInClaudeCode();
        await detectAvailableAgents(true);
        await postState();
        webview.postMessage({ type: 'open-project-context', project: (await storage.loadBoardState()).project });
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
      case 'show-terminal': {
        const entry = agentTerminals.get(message.id);
        if (entry) {
          entry.terminal.show();
        } else {
          vscode.window.showInformationMessage(`No live agent terminal for ${message.id}.`);
        }
        break;
      }
      case 'ship-task':
        await runShipAction(message.id, message.expectedLastUpdated);
        await postState();
        break;
      case 'archive-task':
        await storage.archiveTask(message.id);
        await postState();
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

  broadcast({ type: 'spec-generating', id });
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Generating PRD...', cancellable: false },
      async () => {
        let provider = getSpecProvider(context);
        if (!provider) {
          // Fall back to whichever agent CLI is installed instead of blocking on setup.
          const available = await detectAvailableAgents();
          provider = available.includes('claude') ? 'claude-code' : available.includes('codex') ? 'codex-cli' : undefined;
          if (provider) {
            await setSpecProvider(context, provider);
          }
        }
        if (!provider) {
          vscode.window.showWarningMessage('No Claude or Codex CLI found. Sign in to an agent CLI or configure OpenAI before generating a PRD.');
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
        const { title: aiTitle, ...specPatch } = aiPatch;
        const currentTitle = task.title?.trim() ?? '';
        const derivedTitle = deriveTaskTitle({ ...task, title: '' });
        const useAiTitle = Boolean(aiTitle) && (!currentTitle || currentTitle === derivedTitle);
        const advanceToReady = task.status === 'backlog';
        await storage.saveTask({
          task: {
            id,
            title: useAiTitle ? aiTitle! : currentTitle || derivedTitle,
            ...specPatch,
            ...(advanceToReady ? { status: 'ready-for-agent' as const } : {}),
            activityLog: [
              ...(task.activityLog ?? []),
              { timestamp: new Date().toISOString(), actor: provider, message: advanceToReady ? 'Generated PRD. Moved to ready-for-agent.' : 'Generated PRD.' }
            ]
          },
          expectedLastUpdated
        }, provider);
      }
    );
  } finally {
    broadcast({ type: 'spec-generated', id });
  }
}

function broadcast(message: unknown): void {
  panel?.webview.postMessage(message);
  sidebarView?.webview.postMessage(message);
}

async function runStartBuildAction(id: string): Promise<void> {
  const storage = await resolveStorage();
  const state = await storage.loadBoardState();
  const task = findTask(state.tasks, id);
  const agent = requireAgent(task.assignedAgent, 'Assign Codex or Claude before starting build.');

  if (task.status !== 'ready-for-agent' && task.status !== 'building') {
    throw new Error('Move the task to Ready for Agent before starting build.');
  }

  await ensureAgentCliAvailable(agent);
  await runAgentBoardScript(storage.root.fsPath, ['.agent-board/scripts/claim-task.mjs', id, agent]);
  const claimed = findTask((await storage.loadBoardState()).tasks, id);
  const prompt = buildImplementationPrompt(id, storage.root.fsPath, claimed.worktreePath, claimed.branchName, agent);
  await launchAgentTerminal(storage, id, 'build', agent, prompt, claimed.worktreePath);
  vscode.window.showInformationMessage(`${agentLabel(agent)} started building ${id} in a terminal.`);
  await postState();
}

async function runStartQaAction(id: string): Promise<void> {
  const storage = await resolveStorage();
  const state = await storage.loadBoardState();
  const task = findTask(state.tasks, id);
  const agent = requireAgent(task.qaAgent, 'Assign a Codex or Claude QA agent before starting QA.');

  if (task.status !== 'ready-for-qa' && task.status !== 'failed-qa') {
    throw new Error('Move the task to Ready for QA before starting QA.');
  }

  await ensureAgentCliAvailable(agent);
  await runAgentBoardScript(storage.root.fsPath, ['.agent-board/scripts/start-qa.mjs', id, agent]);
  const started = findTask((await storage.loadBoardState()).tasks, id);
  const prompt = buildQaPrompt(id, storage.root.fsPath, started.worktreePath, started.branchName);
  await launchAgentTerminal(storage, id, 'qa', agent, prompt, started.worktreePath);
  vscode.window.showInformationMessage(`${agentLabel(agent)} started QA for ${id} in a terminal.`);
  await postState();
}

async function runShipAction(id: string, expectedLastUpdated?: string): Promise<void> {
  const storage = await resolveStorage();
  const task = findTask((await storage.loadBoardState()).tasks, id);
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Shipping ${id}...`, cancellable: false },
    () => shipTask(storage, task, expectedLastUpdated)
  );
  vscode.window.showInformationMessage(outcome);
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

async function launchAgentTerminal(
  storage: Awaited<ReturnType<typeof getWorkspaceStorage>>,
  taskId: string,
  kind: AgentKind,
  agent: Exclude<AssignedAgent, 'unassigned'>,
  prompt: string,
  worktreePath: string
): Promise<void> {
  const promptUri = vscode.Uri.joinPath(storage.boardDir, 'prompts', `${taskId}-${kind}.md`);
  await vscode.workspace.fs.writeFile(promptUri, new TextEncoder().encode(prompt));

  const previous = agentTerminals.get(taskId);
  if (previous) {
    // Deregister first so onDidCloseTerminal does not treat this as an interrupted run.
    agentTerminals.delete(taskId);
    previous.terminal.dispose();
  }

  const terminal = vscode.window.createTerminal({
    name: `Agent Board: ${taskId} ${kind} (${agentLabel(agent)})`,
    cwd: worktreePath || storage.root.fsPath
  });
  agentTerminals.set(taskId, { terminal, kind });
  terminal.show();
  terminal.sendText(agentLaunchCommand(agent, promptUri.fsPath));
}

function agentLaunchCommand(agent: Exclude<AssignedAgent, 'unassigned'>, promptPath: string): string {
  // POSIX shells only; the prompt lives in a file to avoid multi-line sendText quoting issues.
  if (agent === 'claude') {
    return `claude -p "$(cat ${shellQuote(promptPath)})"`;
  }
  return `codex exec --skip-git-repo-check "$(cat ${shellQuote(promptPath)})"`;
}

function buildImplementationPrompt(id: string, mainRoot: string, worktreePath: string, branchName: string, agent: CliAgent): string {
  const taskFile = `${mainRoot}/.agent-board/tasks/${id}.json`;
  const scripts = `${mainRoot}/.agent-board/scripts`;
  return [
    `You are the assigned implementation agent for Agent Board task ${id}.`,
    worktreePath
      ? `Your working directory is a dedicated git worktree on branch ${branchName}. Do all code work here and commit to this branch.`
      : 'Your working directory is the repository root.',
    `The durable task record lives in the MAIN checkout: ${taskFile}. Never edit .agent-board files inside a worktree; the board scripts resolve the main checkout automatically.`,
    `Read ${mainRoot}/.agent-board/project.json and the task JSON before editing, including the latest activityLog and qaNotes entries for human or QA feedback.`,
    'Implement only this task. Update relevantFiles, agentNotes, and activityLog in the main task file as you work.',
    `When implementation is complete: run node "${scripts}/run-validation.mjs" ${id} (required - it records validation evidence), then node "${scripts}/complete-task.mjs" ${id}.`,
    `Then run node "${scripts}/claim-next-task.mjs" ${agent}. If it returns a task, continue in its printed worktree and repeat until it prints {"noTask":true}.`,
    'If blocked, update the task with a blocker note and move it to human-review.'
  ].join('\n');
}

function buildQaPrompt(id: string, mainRoot: string, worktreePath: string, branchName: string): string {
  const taskFile = `${mainRoot}/.agent-board/tasks/${id}.json`;
  const scripts = `${mainRoot}/.agent-board/scripts`;
  return [
    `You are the QA agent for Agent Board task ${id}.`,
    worktreePath
      ? `Your working directory is the task's git worktree on branch ${branchName}; review the implementation here.`
      : 'Your working directory is the repository root.',
    `The durable task record lives in the MAIN checkout: ${taskFile}. Never edit .agent-board files inside a worktree.`,
    `Read ${mainRoot}/.agent-board/project.json and the task JSON.`,
    'Review acceptanceCriteria, qaChecklist, designQaChecklist, changed files on the branch, agentNotes, and validation evidence.',
    `Run node "${scripts}/run-validation.mjs" ${id} to verify the validation commands pass, plus any functional checks the task calls for. Record findings in qaEvidence.`,
    `If QA passes, run: node "${scripts}/pass-qa.mjs" ${id} "QA passed."`,
    `If QA fails, run: node "${scripts}/fail-qa.mjs" ${id} "specific failure reason"`
  ].join('\n');
}

function buildRepairPrompt(id: string, mainRoot: string, worktreePath: string, branchName: string, agent: CliAgent): string {
  const taskFile = `${mainRoot}/.agent-board/tasks/${id}.json`;
  const scripts = `${mainRoot}/.agent-board/scripts`;
  return [
    `You are the implementation agent automatically repairing failed QA for Agent Board task ${id}.`,
    worktreePath
      ? `Work only in the existing task worktree on branch ${branchName}. Commit the repair to this branch.`
      : 'Work in the repository root.',
    `Read the durable task record at ${taskFile}, especially the latest qaNotes, qaEvidence, activityLog, and failed validation output.`,
    `Also read ${mainRoot}/.agent-board/project.json before editing.`,
    'Fix the specific QA failure without expanding task scope. Update agentNotes, relevantFiles, and activityLog as you work.',
    `When repaired, run node "${scripts}/run-validation.mjs" ${id}, then node "${scripts}/complete-task.mjs" ${id}. QA will start again automatically.`,
    `Then run node "${scripts}/claim-next-task.mjs" ${agent} and continue any returned task until it prints {"noTask":true}.`,
    'If the failure cannot be repaired safely, record the blocker and move the task to human-review.'
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
    void refreshBoard();
  }, 150);
}

async function refreshBoard(): Promise<void> {
  await startReadyQaTasks();
  await startFailedQaRepairs();
  await startReadyBuildTasks();
  await postState();
}

async function startReadyBuildTasks(): Promise<void> {
  if (!vscode.workspace.getConfiguration('agentBoard').get<boolean>('autoContinue', true)) return;
  if ([...agentTerminals.values()].some((entry) => entry.kind === 'build') || autoBuildStarting.size) return;
  const storage = await resolveStorage();
  const { tasks } = await storage.loadBoardState();
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const task = tasks
    .filter((candidate) => candidate.status === 'ready-for-agent' && autoBuildAttemptedVersions.get(candidate.id) !== candidate.lastUpdated)
    .sort((a, b) => rank[a.priority] - rank[b.priority] || a.id.localeCompare(b.id))[0];
  if (!task) return;

  autoBuildStarting.add(task.id);
  autoBuildAttemptedVersions.set(task.id, task.lastUpdated);
  try {
    let ready = task;
    if (ready.assignedAgent === 'unassigned') {
      const assignedAgent = await pickAutoAgent();
      if (assignedAgent === 'unassigned') throw new Error('No signed-in Codex or Claude CLI is available.');
      ready = await storage.saveTask({ task: { id: ready.id, assignedAgent }, expectedLastUpdated: ready.lastUpdated });
      autoBuildAttemptedVersions.set(ready.id, ready.lastUpdated);
    }
    await runStartBuildAction(ready.id);
  } catch (error) {
    const current = (await storage.loadBoardState()).tasks.find((candidate) => candidate.id === task.id);
    if (current) autoBuildAttemptedVersions.set(current.id, current.lastUpdated);
    vscode.window.showErrorMessage(`Automatic build could not start for ${task.id}. ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    autoBuildStarting.delete(task.id);
  }
}

async function startReadyQaTasks(): Promise<void> {
  const storage = await resolveStorage();
  const { tasks } = await storage.loadBoardState();
  const ready = tasks.filter((task) =>
    task.status === 'ready-for-qa'
    && !agentTerminals.has(task.id)
    && !autoQaStarting.has(task.id)
    && autoQaAttemptedVersions.get(task.id) !== task.lastUpdated
  );

  await Promise.all(ready.map(async (task) => {
    autoQaStarting.add(task.id);
    autoQaAttemptedVersions.set(task.id, task.lastUpdated);
    try {
      await runStartQaAction(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Automatic QA could not start for ${task.id}. ${message}`);
    } finally {
      autoQaStarting.delete(task.id);
    }
  }));
}

async function startFailedQaRepairs(): Promise<void> {
  const storage = await resolveStorage();
  const { tasks } = await storage.loadBoardState();
  const failed = tasks.filter((task) =>
    task.status === 'failed-qa'
    && agentTerminals.get(task.id)?.kind !== 'build'
    && !autoRepairStarting.has(task.id)
    && autoRepairAttemptedVersions.get(task.id) !== task.lastUpdated
  );

  await Promise.all(failed.map(async (task) => {
    autoRepairStarting.add(task.id);
    autoRepairAttemptedVersions.set(task.id, task.lastUpdated);
    try {
      const agent = requireAgent(task.assignedAgent, 'Assign a Codex or Claude build agent before automatic repair can start.');
      await ensureAgentCliAvailable(agent);
      const now = new Date().toISOString();
      const repairing = await storage.saveTask({
        task: {
          id: task.id,
          status: 'building',
          activityLog: [
            ...(task.activityLog ?? []),
            { timestamp: now, actor: 'vscode', message: 'QA failed. Returned to building and started an automatic repair.' }
          ]
        },
        expectedLastUpdated: task.lastUpdated
      });
      const prompt = buildRepairPrompt(task.id, storage.root.fsPath, repairing.worktreePath, repairing.branchName, agent);
      await launchAgentTerminal(storage, task.id, 'build', agent, prompt, repairing.worktreePath);
      vscode.window.showInformationMessage(`${agentLabel(agent)} started repairing QA feedback for ${task.id}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Automatic QA repair could not start for ${task.id}. ${message}`);
    } finally {
      autoRepairStarting.delete(task.id);
    }
  }));
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
      liveTerminals: [...agentTerminals.keys()],
      settings: {
        specProvider: provider,
        specProviderLabel: specProviderLabel(provider),
        setupComplete: Boolean(provider || activeContext?.globalState.get<boolean>(ONBOARDING_COMPLETE_KEY)),
        autoAssignAgent: await pickAutoAgent()
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
