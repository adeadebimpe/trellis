import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { clearAi, configureAi, configureSpecProvider, generateAgentSpecWithAi, generateTasksFromPrd, getSpecProvider, resetAiSettings, setSpecProvider, specProviderLabel, SpecProvider } from './ai';
import { chooseAgentSignIn, generateClaudeAutomationToken, signInClaudeCode, signInCodexCli } from './cliAuth';
import { isSetupComplete } from './onboarding';
import { shipTask } from './ship';
import { deriveTaskTitle, getPrdSourceBrief } from './prdPrompt';
import { AgentBoardStorage, getWorkspaceStorage, StaleTaskError } from './storage';
import { AgentBoardTask, AssignedAgent } from './types';
import { buildAgentPermissionAllowlist, codexAutomationArgs } from './agentPermissions';
import { shouldStartAutomaticQa } from './agentHandoff';

let panel: vscode.WebviewPanel | undefined;
let sidebarView: vscode.WebviewView | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let activeStorage: Awaited<ReturnType<typeof getWorkspaceStorage>> | undefined;
let activeContext: vscode.ExtensionContext | undefined;
const ONBOARDING_COMPLETE_KEY = 'agentBoard.onboardingComplete';
const PERMISSION_DECISION_KEY = 'agentBoard.agentPermissionDecisionMade';
const MANAGED_PERMISSIONS_KEY = 'agentBoard.managedClaudePermissions';
const SCOPED_AUTOMATION_KEY = 'agentBoard.scopedAutomationEnabled';
const execFileAsync = promisify(execFile);

type AgentKind = 'build' | 'qa';
const agentTerminals = new Map<string, { terminal: vscode.Terminal; kind: AgentKind }>();
const TERMINAL_NAME_PATTERN = /^(?:Trellis|Agent Board): (\S+) (build|qa) /;
const autoQaStarting = new Set<string>();
const autoQaAttemptedVersions = new Map<string, string>();
const autoRepairStarting = new Set<string>();
const autoRepairAttemptedVersions = new Map<string, string>();
// Task ids with a PRD generation in flight, so reopened webviews can restore the indicator.
const generatingSpecs = new Set<string>();
const autoBuildStarting = new Set<string>();
const autoBuildAttemptedVersions = new Map<string, string>();

type CliAgent = Exclude<AssignedAgent, 'unassigned'>;
let detectedAgentsPromise: Promise<CliAgent[]> | undefined;

function detectAvailableAgents(force = false): Promise<CliAgent[]> {
  if (!detectedAgentsPromise || force) {
    detectedAgentsPromise = Promise.all(
      (['codex', 'claude'] as const).map((agent) =>
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

// Honors an explicit agent choice from the Create Task composer when that CLI
// is actually available; otherwise falls back to the automatic pick.
async function resolveRequestedAgent(requested: unknown): Promise<AssignedAgent> {
  if (requested === 'claude' || requested === 'codex') {
    const available = await detectAvailableAgents();
    if (available.includes(requested)) {
      return requested;
    }
  }
  if (requested === 'unassigned') {
    return 'unassigned';
  }
  return pickAutoAgent();
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
      vscode.window.showInformationMessage('Trellis files are ready.');
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
          view.webview.html = getHtml(view.webview, context.extensionUri, 'sidebar');
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
    console.error('Trellis: failed to handle closed agent terminal', error);
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

  panel = vscode.window.createWebviewPanel('agentBoard', 'Trellis', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
  });

  panel.webview.html = getHtml(panel.webview, context.extensionUri, 'panel');
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
        const autoAgent = await resolveRequestedAgent(message.agent);
        const autoQaAgent = await resolveRequestedAgent(message.qaAgent);
        const task = await storage.createTask(brief
          ? { brief, assignedAgent: autoAgent, qaAgent: autoQaAgent }
          : undefined);
        await postState();
        if (brief) {
          // Keep the panel closed while the PRD drafts; the webview only auto-opens
          // on success and only if the user has not focused another task meanwhile.
          const generated = await runGenerateSpecAction(context, task.id, task.lastUpdated);
          await postState();
          if (generated) {
            try {
              webview.postMessage({ type: 'auto-select-task', id: task.id });
            } catch {
              // Webview closed during generation; the finished task is already on the board.
            }
          }
        } else {
          webview.postMessage({ type: 'select-task', id: task.id });
        }
        break;
      }
      case 'select-intake-files': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: 'Attach to intake',
          title: 'Choose screenshots, images, PRDs, or supporting files',
          filters: {
            'Images, Markdown, and text': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'md', 'txt']
          }
        });
        webview.postMessage({
          type: 'intake-files-selected',
          files: (picked ?? []).map((uri) => ({ name: uri.path.split('/').pop() ?? 'attachment', path: uri.fsPath }))
        });
        break;
      }
      case 'create-intake': {
        const text = String(message.intake?.text ?? '').trim();
        if (!text) throw new Error('Add some source material before creating a draft.');
        const sourceUrl = String(message.intake?.sourceUrl ?? '').trim();
        if (sourceUrl) {
          try {
            const parsed = new URL(sourceUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
          } catch {
            throw new Error('Source URL must be a valid http or https URL.');
          }
        }
        const allowedIntents = new Set(['single-task', 'decompose', 'define', 'investigate']);
        const intent = allowedIntents.has(message.intake?.intent) ? message.intake.intent : 'single-task';
        const autoAgent = await resolveRequestedAgent(message.agent);
        const autoQaAgent = await resolveRequestedAgent(message.qaAgent);
        const now = new Date().toISOString();
        const mentions: string[] = Array.isArray(message.mentions)
          ? Array.from(new Set<string>((message.mentions as unknown[]).map((entry) => String(entry).trim()).filter(Boolean))).slice(0, 20)
          : [];
        const task = await storage.createTask({
          brief: text,
          assignedAgent: autoAgent,
          qaAgent: autoQaAgent,
          intake: { method: 'manual', text, sourceUrl: sourceUrl || undefined, attachments: [], intent, createdAt: now }
        });
        const paths = Array.isArray(message.intake?.attachmentPaths)
          ? Array.from(new Set<string>(
            message.intake.attachmentPaths
              .map(String)
              .filter((path: string) => /\.(?:png|jpe?g|gif|webp|md|txt)$/i.test(path))
          ))
          : [];
        const copied = await storage.copyIntakeAttachments(task.id, paths);
        // @mentioned workspace files ride along as intake attachments so the PRD
        // prompt treats them as user-provided evidence (never fabricated content).
        const attachments = [
          ...copied,
          ...mentions
            .filter((path) => !paths.includes(path))
            .map((path) => ({ name: path.split('/').pop() ?? path, path, mediaType: 'text/x-workspace-file', size: 0 }))
        ];
        const withIntake = await storage.saveTask({
          task: {
            id: task.id,
            intake: { method: 'manual', text, sourceUrl: sourceUrl || undefined, attachments, intent, createdAt: now },
            relevantFiles: mentions,
            activityLog: [
              ...(task.activityLog ?? []),
              { timestamp: now, actor: 'human', message: `Submitted ${intent} intake with ${attachments.length} attachment(s) for draft review.` }
            ]
          },
          expectedLastUpdated: task.lastUpdated
        });
        await postState();
        // Chat-created tasks advance to Ready for Agent once the PRD drafts;
        // the user reviews it in the detail page rather than a Backlog hold.
        await runGenerateSpecAction(context, task.id, withIntake.lastUpdated);
        await postState();
        webview.postMessage({ type: 'intake-created', id: task.id });
        break;
      }
      case 'workspace-files': {
        const uris = await vscode.workspace.findFiles(
          '**/*',
          '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.agent-board/**,**/*.vsix,**/*.png,**/*.jpg}',
          500
        );
        const files = uris.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort((a, b) => a.localeCompare(b));
        webview.postMessage({ type: 'workspace-files', files });
        break;
      }
      case 'create-from-prd': {
        const prd = String(message.prd ?? '').trim();
        if (!prd) {
          throw new Error('Paste a PRD before generating tasks.');
        }
        const agent = await resolveRequestedAgent(message.agent);
        const qaAgent = await resolveRequestedAgent(message.qaAgent);
        webview.postMessage({ type: 'prd-split-started' });
        try {
          const seeds = await generateTasksFromPrd(context, prd, storage.root.fsPath);
          if (!seeds.length) {
            throw new Error('The agent could not derive any tasks from that PRD.');
          }
          const now = new Date().toISOString();
          for (const seed of seeds) {
            const task = await storage.createTask({ brief: seed.brief, assignedAgent: agent, qaAgent });
            await storage.saveTask({
              task: {
                id: task.id,
                title: seed.title,
                description: seed.description,
                acceptanceCriteria: seed.acceptanceCriteria,
                priority: seed.priority,
                // The PRD split already yields an implementation-ready spec.
                status: 'ready-for-agent',
                activityLog: [
                  ...(task.activityLog ?? []),
                  { timestamp: now, actor: 'vscode', message: 'Created from PRD split.' }
                ]
              },
              expectedLastUpdated: task.lastUpdated
            });
          }
          await postState();
          webview.postMessage({ type: 'prd-split-created', count: seeds.length });
          vscode.window.showInformationMessage(`Trellis created ${seeds.length} task(s) from the PRD.`);
        } finally {
          webview.postMessage({ type: 'prd-split-done' });
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
        if (current.status !== 'human-review' && current.status !== 'failed-qa') {
          throw new Error('Comments can send tasks back from Human Review or Failed QA.');
        }
        const now = new Date().toISOString();
        const phase = current.status;
        await storage.saveTask({
          task: {
            id: current.id,
            status: 'ready-for-agent',
            comments: [
              ...(current.comments ?? []),
              { id: `${current.id}-${Date.now()}`, author: 'human', phase, message: feedback, createdAt: now }
            ],
            activityLog: [
              ...(current.activityLog ?? []),
              { timestamp: now, actor: 'human', message: `Comment from ${phase}: ${feedback}` }
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
      case 'infer-project': {
        // Flush the webview's dirty draft inside the same handler so the scan
        // reads it from disk — two separate messages could interleave.
        if (message.project) {
          await storage.saveProjectContext(message.project);
        }
        const project = await storage.inferProjectContext();
        webview.postMessage({ type: 'inferred-project', project });
        await postState();
        break;
      }
      case 'sign-in-agents':
        await chooseAgentSignIn();
        break;
      case 'sign-in-codex':
        await saveWorkflowChoice(storage, message.workflowMode);
        await setSpecProvider(context, 'codex-cli');
        await context.globalState.update(ONBOARDING_COMPLETE_KEY, true);
        signInCodexCli();
        await detectAvailableAgents(true);
        await postState();
        webview.postMessage({ type: 'open-project-context', source: 'onboarding', project: (await storage.loadBoardState()).project });
        break;
      case 'sign-in-claude':
        await saveWorkflowChoice(storage, message.workflowMode);
        await setSpecProvider(context, 'claude-code');
        await context.globalState.update(ONBOARDING_COMPLETE_KEY, true);
        signInClaudeCode();
        await detectAvailableAgents(true);
        await postState();
        webview.postMessage({ type: 'open-project-context', source: 'onboarding', project: (await storage.loadBoardState()).project });
        break;
      case 'configure-spec-provider':
        await configureSpecProvider(context);
        await postState();
        break;
      case 'continue-to-board':
        await saveWorkflowChoice(storage, message.workflowMode);
        await context.globalState.update(ONBOARDING_COMPLETE_KEY, true);
        await postState();
        break;
      case 'configure-agent-permissions': {
        const project = (await storage.loadBoardState()).project;
        const allowlist = buildAgentPermissionAllowlist(project.validationCommands);
        if (message.action === 'grant') {
          await storage.grantClaudePermissions(allowlist);
          await context.workspaceState.update(MANAGED_PERMISSIONS_KEY, allowlist);
          await context.workspaceState.update(SCOPED_AUTOMATION_KEY, true);
          await context.workspaceState.update(PERMISSION_DECISION_KEY, true);
          vscode.window.showInformationMessage('Trellis agent workflow permissions were added to .claude/settings.json.');
        } else if (message.action === 'revoke') {
          const managed = context.workspaceState.get<string[]>(MANAGED_PERMISSIONS_KEY) ?? allowlist;
          await storage.revokeClaudePermissions(managed);
          await context.workspaceState.update(MANAGED_PERMISSIONS_KEY, undefined);
          await context.workspaceState.update(SCOPED_AUTOMATION_KEY, false);
          await context.workspaceState.update(PERMISSION_DECISION_KEY, true);
          vscode.window.showInformationMessage('Trellis agent workflow permissions were removed. Other Claude settings were preserved.');
        } else if (message.action === 'decline') {
          // A decline is deliberately state-only: do not create or modify settings.json.
          await context.workspaceState.update(SCOPED_AUTOMATION_KEY, false);
          await context.workspaceState.update(PERMISSION_DECISION_KEY, true);
        }
        await postState();
        break;
      }
      case 'open-full-board':
        await openBoard(context);
        break;
      case 'show-terminal': {
        let entry = agentTerminals.get(message.id);
        if (!entry) {
          // The map can lose entries across extension-host restarts even though
          // the terminal itself survived; re-adopt it by name before giving up.
          const found = vscode.window.terminals.find((terminal) => TERMINAL_NAME_PATTERN.exec(terminal.name)?.[1] === message.id);
          if (found) {
            const kind = (TERMINAL_NAME_PATTERN.exec(found.name)?.[2] ?? 'build') as AgentKind;
            entry = { terminal: found, kind };
            agentTerminals.set(message.id, entry);
          }
        }
        if (entry) {
          entry.terminal.show(false);
        } else {
          vscode.window.showInformationMessage(`No live agent terminal for ${message.id}. Check the terminal panel for a "Trellis: ${message.id}" entry.`);
          await postState();
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

async function runGenerateSpecAction(context: vscode.ExtensionContext, id: string, expectedLastUpdated?: string, advanceBacklog = true): Promise<boolean> {
  const storage = await resolveStorage();
  const state = await storage.loadBoardState();
  const task = state.tasks.find((item) => item.id === id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }
  if (!getPrdSourceBrief(task)) {
    vscode.window.showWarningMessage('Add your rough feature idea in the Brief field before generating a PRD.');
    return false;
  }

  let succeeded = false;
  generatingSpecs.add(id);
  broadcast({ type: 'spec-generating', id });
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Generating PRD...', cancellable: false },
      async () => {
        let provider: SpecProvider | undefined = task.assignedAgent === 'codex'
          ? 'codex-cli'
          : task.assignedAgent === 'claude'
            ? 'claude-code'
            : getSpecProvider(context);
        if (!provider) {
          // Fall back to whichever agent CLI is installed instead of blocking on setup.
          const available = await detectAvailableAgents();
          provider = available.includes('codex') ? 'codex-cli' : available.includes('claude') ? 'claude-code' : undefined;
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
          aiPatch = await generateAgentSpecWithAi(context, task, state.project, storage.root.fsPath, provider);
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
        const advanceToReady = advanceBacklog && task.status === 'backlog';
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
        succeeded = true;
      }
    );
  } finally {
    generatingSpecs.delete(id);
    broadcast({ type: 'spec-generated', id });
  }
  return succeeded;
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

  if (task.status !== 'ready-for-agent') {
    throw new Error('Move the task to Ready for Agent before starting build.');
  }

  await ensureAgentCliAvailable(agent);
  await runAgentBoardScript(storage.root.fsPath, ['.agent-board/scripts/claim-task.mjs', id, agent]);
  const claimed = findTask((await storage.loadBoardState()).tasks, id);
  if (claimed.claimWarning) {
    vscode.window.showWarningMessage(claimed.claimWarning);
  }
  const prompt = buildImplementationPrompt(id, storage.root.fsPath, claimed.worktreePath, claimed.branchName, agent);
  await launchAgentTerminal(storage, id, 'build', agent, prompt, claimed.worktreePath, claimed.branchName);
  void vscode.window.showInformationMessage(`${agentLabel(agent)} started building ${id} in a terminal.`, 'Show terminal').then((choice) => {
    if (choice === 'Show terminal') {
      agentTerminals.get(id)?.terminal.show();
    }
  });
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
  await launchAgentTerminal(storage, id, 'qa', agent, prompt, started.worktreePath, started.branchName);
  void vscode.window.showInformationMessage(`${agentLabel(agent)} started QA for ${id} in a terminal.`, 'Show terminal').then((choice) => {
    if (choice === 'Show terminal') {
      agentTerminals.get(id)?.terminal.show();
    }
  });
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
    throw new Error(`Trellis could not claim the task. ${error instanceof Error ? error.message : String(error)}`);
  }
}

// The task JSON can reference a worktree that no longer exists on disk
// (pruned, removed by a ship, or deleted manually). A terminal launched with
// a missing cwd fails outright, so restore the worktree from the task branch
// when possible and fall back to the repository root otherwise.
async function resolveTerminalCwd(
  storage: Awaited<ReturnType<typeof getWorkspaceStorage>>,
  worktreePath: string,
  branchName: string
): Promise<string> {
  const root = storage.root.fsPath;
  if (!worktreePath) {
    return root;
  }
  if (existsSync(worktreePath)) {
    return worktreePath;
  }
  if (branchName) {
    try {
      await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], { cwd: root, timeout: 60000 });
      vscode.window.showInformationMessage(`Trellis restored the missing worktree for ${branchName}.`);
      return worktreePath;
    } catch {
      // fall through to the repository root
    }
  }
  vscode.window.showWarningMessage('The task worktree was missing and could not be restored; the agent terminal opened in the repository root.');
  return root;
}

async function launchAgentTerminal(
  storage: Awaited<ReturnType<typeof getWorkspaceStorage>>,
  taskId: string,
  kind: AgentKind,
  agent: Exclude<AssignedAgent, 'unassigned'>,
  prompt: string,
  worktreePath: string,
  branchName: string
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
    name: `Trellis: ${taskId} ${kind} (${agentLabel(agent)})`,
    cwd: await resolveTerminalCwd(storage, worktreePath, branchName)
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
  const scopedArgs = codexAutomationArgs(Boolean(activeContext?.workspaceState.get<boolean>(SCOPED_AUTOMATION_KEY)));
  return `codex exec --skip-git-repo-check${scopedArgs.length ? ` ${scopedArgs.join(' ')}` : ''} "$(cat ${shellQuote(promptPath)})"`;
}

function buildImplementationPrompt(id: string, mainRoot: string, worktreePath: string, branchName: string, agent: CliAgent): string {
  const taskFile = `${mainRoot}/.agent-board/tasks/${id}.json`;
  const scripts = `${mainRoot}/.agent-board/scripts`;
  return [
    `You are the assigned implementation agent for Trellis task ${id}.`,
    worktreePath && branchName
      ? `Your working directory is a dedicated git worktree on branch ${branchName}. Do all code work here and commit to this branch.`
      : 'This task uses direct-on-main mode. Work in the repository root, keep changes scoped to this task, and do not start another build concurrently.',
    `The durable task record lives in the MAIN checkout: ${taskFile}. Never edit .agent-board files inside a worktree; the board scripts resolve the main checkout automatically.`,
    `Read ${mainRoot}/.agent-board/project.json and the task JSON before editing, including the latest comments, activityLog, and qaNotes entries for human or QA feedback.`,
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
    `You are the QA agent for Trellis task ${id}.`,
    worktreePath && branchName
      ? `Your working directory is the task's git worktree on branch ${branchName}; review the implementation here.`
      : 'Review the direct-on-main implementation in the repository root.',
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
    `You are the implementation agent automatically repairing failed QA for Trellis task ${id}.`,
    worktreePath && branchName
      ? `Work only in the existing task worktree on branch ${branchName}. Commit the repair to this branch.`
      : 'This repair uses direct-on-main mode. Work in the repository root and keep the repair scoped to this task.',
    `Read the durable task record at ${taskFile}, especially the latest comments, qaNotes, qaEvidence, activityLog, and failed validation output.`,
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
    'Fresh start Trellis?',
    { modal: true, detail: 'Reset setup only clears saved Trellis provider/onboarding state. Reset board files also recreates .agent-board/ for this workspace.' },
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
    vscode.window.showInformationMessage('Trellis setup and .agent-board files were reset.');
  } else {
    vscode.window.showInformationMessage('Trellis setup state was reset.');
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
  const ready = tasks.filter((task) => shouldStartAutomaticQa(
    task.status,
    agentTerminals.get(task.id)?.kind,
    autoQaStarting.has(task.id),
    autoQaAttemptedVersions.get(task.id),
    task.lastUpdated
  ));

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
      await storage.saveTask({
        task: {
          id: task.id,
          status: 'ready-for-agent',
          activityLog: [
            ...(task.activityLog ?? []),
            { timestamp: now, actor: 'vscode', message: 'QA failed. Returned to building and started an automatic repair.' }
          ]
        },
        expectedLastUpdated: task.lastUpdated
      });
      await runAgentBoardScript(storage.root.fsPath, ['.agent-board/scripts/claim-task.mjs', task.id, agent]);
      const repairing = findTask((await storage.loadBoardState()).tasks, task.id);
      const prompt = buildRepairPrompt(task.id, storage.root.fsPath, repairing.worktreePath, repairing.branchName, agent);
      await launchAgentTerminal(storage, task.id, 'build', agent, prompt, repairing.worktreePath, repairing.branchName);
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
  const availableAgents = await detectAvailableAgents();
  const permissionAllowlist = buildAgentPermissionAllowlist(state.project.validationCommands);
  const permissionStatus = await storage.getClaudePermissionStatus(permissionAllowlist);
  const message = {
    type: 'state',
    state: {
      ...state,
      liveTerminals: [...agentTerminals.keys()],
      generatingIds: [...generatingSpecs],
      settings: {
        specProvider: provider,
        specProviderLabel: specProviderLabel(provider),
        setupComplete: isSetupComplete(
          Boolean(provider),
          Boolean(activeContext?.globalState.get<boolean>(ONBOARDING_COMPLETE_KEY)),
          availableAgents.length
        ),
        autoAssignAgent: await pickAutoAgent(),
        agentPermissions: {
          allowlist: permissionAllowlist,
          codexMode: codexAutomationArgs(true).join(' '),
          enabled: permissionStatus.enabled,
          decisionMade: permissionStatus.enabled || Boolean(activeContext?.workspaceState.get<boolean>(PERMISSION_DECISION_KEY))
        }
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

async function saveWorkflowChoice(storage: AgentBoardStorage, value: unknown): Promise<void> {
  const workflowMode = value === 'direct-on-main' ? 'direct-on-main' : 'branch-per-task';
  const { project } = await storage.loadBoardState();
  await storage.saveProjectContext({ ...project, workflowMode });
}

type WebviewHost = 'sidebar' | 'panel';

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, host: WebviewHost): string {
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
  <title>Trellis</title>
</head>
<body data-host="${host}">
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
