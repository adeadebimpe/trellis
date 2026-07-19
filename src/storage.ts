import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { agentsMarkdown, boardGitignore, boardLibScript, claimNextTaskScript, claimTaskScript, claudeSkillMarkdown, columns, completeTaskScript, failQaScript, heartbeatTaskScript, passQaScript, runValidationScript, startQaScript } from './agentFiles';
import { withLock } from './locks';
import { ensureAgentBoardIgnore } from './gitignore';
import { deriveTaskTitle } from './prdPrompt';
import { selectMergedTasksToArchive } from './archive';
import { assertBoardActionAllowed, assertStatusChangeAllowed } from './taskLifecycle';
import { assertTaskId, assertTaskLockKey } from './taskIds';
import { AgentBoardFile, AgentBoardTask, AssignedAgent, IntakeAttachment, ProjectContext, ProjectInference, SaveTaskRequest, TaskStatus } from './types';
import { ClaudeSettings, hasAgentPermissions, mergeAgentPermissions, removeAgentPermissions } from './agentPermissions';

const execFileAsync = promisify(execFile);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const trackedBoardNoticeRoots = new Set<string>();

export class StaleTaskError extends Error {
  constructor() {
    super('Task was updated by another process. Refreshing board.');
  }
}

export class AgentBoardStorage {
  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder) {}

  get root(): vscode.Uri {
    return this.workspaceFolder.uri;
  }

  get boardDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, '.agent-board');
  }

  async getClaudePermissionStatus(allowlist: string[]): Promise<{ enabled: boolean; settingsExist: boolean }> {
    const uri = vscode.Uri.joinPath(this.root, '.claude', 'settings.json');
    if (!await this.exists(uri)) return { enabled: false, settingsExist: false };
    try {
      const settings = await this.readJson<ClaudeSettings>(uri);
      return { enabled: hasAgentPermissions(settings, allowlist), settingsExist: true };
    } catch {
      // Keep the board usable. Grant/revoke still surfaces the parse error rather
      // than replacing a malformed user-owned settings file.
      return { enabled: false, settingsExist: true };
    }
  }

  async grantClaudePermissions(allowlist: string[]): Promise<void> {
    const directory = vscode.Uri.joinPath(this.root, '.claude');
    const uri = vscode.Uri.joinPath(directory, 'settings.json');
    await this.ensureDir(directory);
    const existing = await this.exists(uri) ? await this.readJson<ClaudeSettings>(uri) : {};
    await this.writeJson(uri, mergeAgentPermissions(existing, allowlist));
  }

  async revokeClaudePermissions(managed: string[]): Promise<void> {
    const uri = vscode.Uri.joinPath(this.root, '.claude', 'settings.json');
    if (!await this.exists(uri)) return;
    const existing = await this.readJson<ClaudeSettings>(uri);
    await this.writeJson(uri, removeAgentPermissions(existing, managed));
  }

  async prepareAgentFiles(): Promise<void> {
    await this.ensureRootGitignore();
    await this.ensureDir(this.boardDir);
    for (const dir of ['tasks', 'qa', 'scripts', 'locks', 'prompts', 'worktrees', 'archive']) {
      await this.ensureDir(vscode.Uri.joinPath(this.boardDir, dir));
    }
    await this.ensureDir(vscode.Uri.joinPath(this.root, '.claude', 'skills', 'agent-board'));

    await this.ensureProjectContext();

    await this.upsertMarkdownSection(vscode.Uri.joinPath(this.root, 'AGENTS.md'), '## Agent Board Workflow', agentsMarkdown());
    await this.ensureFile(vscode.Uri.joinPath(this.root, '.claude', 'skills', 'agent-board', 'SKILL.md'), claudeSkillMarkdown());
    const scripts: Array<[string, string]> = [
      ['_lib.mjs', boardLibScript()],
      ['claim-next-task.mjs', claimNextTaskScript()],
      ['claim-task.mjs', claimTaskScript()],
      ['heartbeat-task.mjs', heartbeatTaskScript()],
      ['complete-task.mjs', completeTaskScript()],
      ['start-qa.mjs', startQaScript()],
      ['run-validation.mjs', runValidationScript()],
      ['pass-qa.mjs', passQaScript()],
      ['fail-qa.mjs', failQaScript()]
    ];
    for (const [name, content] of scripts) {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.boardDir, 'scripts', name), encoder.encode(content));
    }
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.boardDir, '.gitignore'), encoder.encode(boardGitignore()));
    await this.ensureFile(vscode.Uri.joinPath(this.boardDir, 'activity.log'), '');
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.boardDir, 'board.json'));
    } catch {
      // board.json is derived state and no longer persisted; nothing to clean.
    }
  }

  private async ensureRootGitignore(): Promise<void> {
    const enabled = vscode.workspace.getConfiguration('agentBoard', this.root)
      .get<boolean>('gitignoreBoardDirectory', true);
    if (!enabled || !await this.exists(vscode.Uri.joinPath(this.root, '.git'))) {
      return;
    }

    const gitignoreUri = vscode.Uri.joinPath(this.root, '.gitignore');
    let existing = '';
    try {
      existing = decoder.decode(await vscode.workspace.fs.readFile(gitignoreUri));
    } catch {
      // A missing root .gitignore is created below.
    }
    const next = ensureAgentBoardIgnore(existing);
    if (next !== existing) {
      await vscode.workspace.fs.writeFile(gitignoreUri, encoder.encode(next));
    }

    const rootPath = this.root.fsPath;
    if (trackedBoardNoticeRoots.has(rootPath)) {
      return;
    }
    trackedBoardNoticeRoots.add(rootPath);
    try {
      const { stdout } = await execFileAsync('git', ['ls-files', '--', '.agent-board'], {
        cwd: rootPath,
        timeout: 10000
      });
      if (stdout.trim()) {
        vscode.window.showInformationMessage(
          'Trellis is now git-ignored, but existing board files are still tracked. To untrack them, run: git rm -r --cached .agent-board'
        );
      }
    } catch {
      // Ignore read-only Git inspection failures; initialization still succeeds.
    }
  }

  async resetBoardFiles(): Promise<void> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(this.boardDir, 'worktrees'));
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory) {
          await this.removeWorktree(vscode.Uri.joinPath(this.boardDir, 'worktrees', name).fsPath);
        }
      }
    } catch {
      // No worktrees to clean up.
    }
    try {
      await vscode.workspace.fs.delete(this.boardDir, { recursive: true, useTrash: false });
    } catch {
      // Missing board files already represent a fresh workspace.
    }
    await this.prepareAgentFiles();
  }

  async loadBoardState(): Promise<{ board: AgentBoardFile; tasks: AgentBoardTask[]; project: ProjectContext }> {
    let tasks = await this.loadTasksOrEmpty();
    if (!await this.exists(this.boardDir)) {
      await this.prepareAgentFiles();
      tasks = await this.loadTasks();
    }
    const archivedIds = selectMergedTasksToArchive(tasks);
    for (const id of archivedIds) {
      await this.archiveTask(id);
    }
    if (archivedIds.length) {
      const archived = new Set(archivedIds);
      tasks = tasks.filter((task) => !archived.has(task.id));
    }
    const project = await this.loadProjectContext();
    const board: AgentBoardFile = {
      version: 1,
      columns: columns.map((column) => ({ id: column.id, title: column.title })),
      tasks: tasks.map(({ id, title, status, priority, assignedAgent, qaAgent, lastUpdated }) => ({ id, title, status, priority, assignedAgent, qaAgent, lastUpdated })),
      lastUpdated: new Date().toISOString()
    };
    return { board, tasks, project };
  }

  async createTask(initial?: Partial<AgentBoardTask>): Promise<AgentBoardTask> {
    await this.prepareAgentFiles();
    return this.withTaskLock('_board', 'vscode', async () => {
      const tasks = await this.loadTasks();
      const archivedIds = await this.loadArchivedTaskIds();
      const nextNumber = [...tasks.map((task) => task.id), ...archivedIds]
        .map((id) => Number(id.replace(/^TASK-/, '')))
        .filter(Number.isFinite)
        .reduce((max, value) => Math.max(max, value), 0) + 1;
      const id = `TASK-${String(nextNumber).padStart(3, '0')}`;
      const task = this.blankTask(id);
      const brief = String(initial?.brief ?? '').trim();
      if (brief) {
        task.brief = brief;
        const derived = deriveTaskTitle(task);
        task.title = derived === task.id ? '' : derived;
      }
      if (initial?.intake) {
        task.intake = initial.intake;
      }
      if (initial?.assignedAgent) {
        task.assignedAgent = this.normalizeAgent(initial.assignedAgent);
      }
      if (initial?.qaAgent) {
        task.qaAgent = this.normalizeAgent(initial.qaAgent);
      }
      await this.writeJson(vscode.Uri.joinPath(this.boardDir, 'tasks', `${id}.json`), task);
      await this.appendRootActivity('vscode', `Created ${id}.`);
      return task;
    });
  }

  async copyIntakeAttachments(taskId: string, sourcePaths: string[]): Promise<IntakeAttachment[]> {
    assertTaskId(taskId);
    if (!sourcePaths.length) return [];
    const destinationDir = vscode.Uri.joinPath(this.boardDir, 'attachments', taskId);
    await this.ensureDir(destinationDir);
    const attachments: IntakeAttachment[] = [];
    for (const sourcePath of sourcePaths) {
      const source = vscode.Uri.file(sourcePath);
      const name = source.path.split('/').pop() || 'attachment';
      const destination = vscode.Uri.joinPath(destinationDir, name);
      await vscode.workspace.fs.copy(source, destination, { overwrite: false });
      const stat = await vscode.workspace.fs.stat(destination);
      attachments.push({
        name,
        path: vscode.workspace.asRelativePath(destination, false),
        mediaType: mediaTypeForName(name),
        size: stat.size
      });
    }
    return attachments;
  }

  async saveTask(request: SaveTaskRequest, actor = 'vscode'): Promise<AgentBoardTask> {
    await this.prepareAgentFiles();
    return this.withTaskLock(request.task.id, actor, () => this.saveTaskLocked(request, actor));
  }

  private async saveTaskLocked(request: SaveTaskRequest, actor: string): Promise<AgentBoardTask> {
    const uri = this.taskUri(request.task.id);
    const existing = await this.readJson<AgentBoardTask>(uri);
    if (request.expectedLastUpdated && existing.lastUpdated !== request.expectedLastUpdated) {
      throw new StaleTaskError();
    }
    if (request.task.status) {
      assertStatusChangeAllowed(existing, request.task.status);
    }

    const now = new Date().toISOString();
    const incomingLog = Array.isArray(request.task.activityLog) ? request.task.activityLog : undefined;
    const merged: AgentBoardTask = {
      ...existing,
      ...request.task,
      activityLog: incomingLog ?? existing.activityLog ?? [],
      lastUpdated: now
    };
    if (!incomingLog) {
      merged.activityLog = [...(existing.activityLog ?? []), { timestamp: now, actor, message: 'Updated task.' }];
    }
    if (!String(merged.title ?? '').trim()) {
      const derived = deriveTaskTitle(merged);
      merged.title = derived === merged.id ? '' : derived;
    }

    await this.writeJson(uri, merged);
    return merged;
  }

  private withTaskLock<T>(key: string, owner: string, fn: () => Promise<T>): Promise<T> {
    assertTaskLockKey(key);
    return withLock(vscode.Uri.joinPath(this.boardDir, 'locks').fsPath, key, owner, fn);
  }

  async moveTask(id: string, status: TaskStatus, expectedLastUpdated?: string): Promise<AgentBoardTask> {
    const task = await this.saveTask({ task: { id, status }, expectedLastUpdated }, 'vscode');
    return task;
  }

  async deleteTask(id: string): Promise<void> {
    await this.prepareAgentFiles();
    await this.withTaskLock(id, 'vscode', async () => {
      let worktreePath = '';
      try {
        worktreePath = (await this.readJson<AgentBoardTask>(this.taskUri(id))).worktreePath ?? '';
      } catch {
        // Task file may already be gone; still attempt the delete below for a clear error.
      }
      if (worktreePath) {
        await this.removeWorktree(worktreePath);
      }
      await vscode.workspace.fs.delete(this.taskUri(id));
    });
    await this.appendRootActivity('vscode', `Deleted ${id}.`);
  }

  async archiveTask(id: string): Promise<void> {
    await this.prepareAgentFiles();
    await this.withTaskLock(id, 'vscode', async () => {
      await vscode.workspace.fs.rename(this.taskUri(id), vscode.Uri.joinPath(this.boardDir, 'archive', `${id}.json`), { overwrite: true });
    });
    await this.appendRootActivity('vscode', `Archived ${id}.`);
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    if (resolve(worktreePath) === resolve(this.root.fsPath)) {
      return; // direct-on-main tasks point at the project root, never remove it.
    }
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: this.root.fsPath, timeout: 20000 });
    } catch {
      // Worktree may already be gone or this is not a git repo.
    }
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: this.root.fsPath, timeout: 20000 });
    } catch {
      // Not a git repo; nothing to prune.
    }
  }

  async saveProjectContext(project: ProjectContext): Promise<ProjectContext> {
    await this.prepareAgentFiles();
    const existing = await this.loadProjectContext();
    const merged: ProjectContext = {
      ...existing,
      ...project,
      workflowMode: project.workflowMode === 'direct-on-main' ? 'direct-on-main' : 'branch-per-task',
      contextMode: ['lean', 'standard', 'full'].includes(project.contextMode ?? '') ? project.contextMode : (existing.contextMode ?? 'standard'),
      contextProfiles: {
        ...existing.contextProfiles,
        ...project.contextProfiles
      },
      inference: {
        ...existing.inference,
        ...project.inference
      },
      lastUpdated: new Date().toISOString()
    };
    await this.writeJson(this.projectUri(), merged);
    await this.appendRootActivity('vscode', 'Updated project context.');
    return merged;
  }

  async inferProjectContext(): Promise<ProjectContext> {
    await this.prepareAgentFiles();
    const existing = await this.loadProjectContext();
    const inference = await this.buildProjectInference();
    const merged: ProjectContext = {
      ...existing,
      inference,
      validationCommands: existing.validationCommands.length ? existing.validationCommands : inference.suggestedValidation,
      architectureNotes: existing.architectureNotes.trim()
        ? existing.architectureNotes
        : this.inferredArchitectureNotes(inference),
      // The scan's only visible surface is the Project context box, so seed it
      // with a readable summary when the user has not written notes yet.
      contextNotes: (existing.contextNotes ?? '').trim()
        ? existing.contextNotes
        : this.inferredContextNotes(inference),
      lastUpdated: new Date().toISOString()
    };
    await this.writeJson(this.projectUri(), merged);
    await this.appendRootActivity('vscode', 'Inferred project context.');
    return merged;
  }

  private inferredContextNotes(inference: ProjectInference): string {
    const lines: string[] = [];
    if (inference.likelyStack.length) {
      lines.push(`Stack: ${inference.likelyStack.join(', ')}`);
    }
    if (inference.packageManager) {
      lines.push(`Package manager: ${inference.packageManager}`);
    }
    if (inference.scripts.length) {
      lines.push(`Scripts: ${inference.scripts.join(', ')}`);
    }
    if (inference.detectedFiles.length) {
      lines.push(`Key files: ${inference.detectedFiles.join(', ')}`);
    }
    if (inference.suggestedValidation.length) {
      lines.push(`Validation: ${inference.suggestedValidation.join(', ')}`);
    }
    return lines.join('\n');
  }

  private inferredArchitectureNotes(inference: ProjectInference): string {
    const lines: string[] = [];
    if (inference.likelyStack.length) {
      lines.push(`Detected stack: ${inference.likelyStack.join(', ')}.`);
    }
    if (inference.packageManager) {
      lines.push(`Package manager: ${inference.packageManager}.`);
    }
    if (inference.detectedFiles.length) {
      lines.push(`Key files: ${inference.detectedFiles.join(', ')}.`);
    }
    return lines.join('\n');
  }

  async runAction(id: string, action: string, expectedLastUpdated?: string): Promise<AgentBoardTask> {
    await this.prepareAgentFiles();
    return this.withTaskLock(id, 'vscode', () => this.runActionLocked(id, action, expectedLastUpdated));
  }

  private async runActionLocked(id: string, action: string, expectedLastUpdated?: string): Promise<AgentBoardTask> {
    const existing = await this.readJson<AgentBoardTask>(this.taskUri(id));
    assertBoardActionAllowed(existing, action);
    const now = new Date().toISOString();
    const patch: Partial<AgentBoardTask> & { id: string } = { id };
    const activity = [...(existing.activityLog ?? [])];
    const add = (message: string) => activity.push({ timestamp: now, actor: 'vscode', message });

    switch (action) {
      case 'generate-spec':
        throw new Error('Generate PRD must use Codex, Claude, or OpenAI. Local generation is disabled.');
      case 'generate-description':
        patch.description = this.generateDescription(existing);
        add('Generated full description draft.');
        break;
      case 'generate-acceptance':
        patch.acceptanceCriteria = this.generateAcceptanceCriteria(existing);
        add('Generated acceptance criteria draft.');
        break;
      case 'generate-qa':
        patch.qaChecklist = this.generateQaChecklist(existing);
        add('Generated QA checklist draft.');
        break;
      case 'mark-ready':
        patch.status = 'ready-for-agent';
        add('Marked ready for agent.');
        break;
      case 'mark-building':
        patch.status = 'building';
        patch.claimedBy = existing.assignedAgent === 'unassigned' ? 'agent' : existing.assignedAgent;
        add('Started build.');
        break;
      case 'assign-claude':
        patch.assignedAgent = 'claude';
        add('Assigned to Claude.');
        break;
      case 'assign-codex':
        patch.assignedAgent = 'codex';
        add('Assigned to Codex.');
        break;
      case 'mark-ready-qa':
        patch.status = 'ready-for-qa';
        add('Marked ready for QA.');
        break;
      case 'start-qa':
        patch.status = 'qa-running';
        patch.qaClaimedBy = existing.qaAgent === 'unassigned' ? 'qa' : existing.qaAgent;
        add('Started QA.');
        break;
      case 'pass-qa':
        patch.status = 'human-review';
        patch.qaNotes = [...(existing.qaNotes ?? []), { timestamp: now, actor: existing.qaClaimedBy || existing.qaAgent || 'qa', message: 'QA passed from board.' }];
        add('QA passed. Moved to human review.');
        break;
      case 'mark-done':
        patch.status = 'done';
        add('Marked done.');
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    patch.activityLog = activity;
    return this.saveTaskLocked({ task: patch, expectedLastUpdated }, 'vscode');
  }

  private generateDescription(task: AgentBoardTask): string {
    const seed = task.description?.trim();
    const title = task.title?.trim() || task.id;
    if (seed && !this.looksLikeSeedDescription(seed, title)) {
      return seed;
    }

    return [
      `Implement "${title}" as a focused repository change.`,
      '',
      seed ? `User intent: ${seed}` : 'User intent: complete the behavior described by the task title.',
      '',
      'Before implementation, read .agent-board/project.json for project overview, rules, validation commands, and inferred repo context.',
      '',
      'The agent should inspect the relevant code paths, make the smallest coherent implementation, update this task with changed files and implementation notes, and run the most relevant validation commands before handing off for QA.'
    ].join('\n');
  }

  private generateAcceptanceCriteria(task: AgentBoardTask): string[] {
    if (task.acceptanceCriteria?.length) {
      return task.acceptanceCriteria;
    }

    const title = task.title?.trim() || 'the requested feature';
    return [
      `${title} is implemented in the appropriate product surface or code path.`,
      'The behavior matches the task description without introducing unrelated changes.',
      'Important edge cases, empty states, and failure states are handled or explicitly noted.',
      'Relevant files changed by the implementation are listed in relevantFiles.',
      'Validation commands pass, or any failures are documented in agentNotes and activityLog.'
    ];
  }

  private generateQaChecklist(task: AgentBoardTask): string[] {
    if (task.qaChecklist?.length) {
      return task.qaChecklist;
    }

    return [
      'Review the changed files for scope and unintended edits.',
      'Run the narrowest relevant automated validation, such as tests, lint, typecheck, or build.',
      'Exercise the main user workflow described by the task.',
      'Check edge cases or empty states implied by the task.',
      'Confirm agentNotes, relevantFiles, activityLog, and status are up to date.'
    ];
  }

  private looksLikeSeedDescription(description: string, title: string): boolean {
    return description.length < 120 || description === title || description.startsWith('Prepare this repository so Agent Board can coordinate');
  }

  private taskUri(id: string): vscode.Uri {
    assertTaskId(id);
    return vscode.Uri.joinPath(this.boardDir, 'tasks', `${id}.json`);
  }

  private projectUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.boardDir, 'project.json');
  }

  private async ensureProjectContext(): Promise<void> {
    try {
      await vscode.workspace.fs.stat(this.projectUri());
    } catch {
      await this.writeJson(this.projectUri(), await this.defaultProjectContext());
    }
  }

  private async loadProjectContext(): Promise<ProjectContext> {
    await this.ensureProjectContext();
    return this.readJson<ProjectContext>(this.projectUri());
  }

  private async defaultProjectContext(): Promise<ProjectContext> {
    return {
      version: 1,
      workflowMode: 'branch-per-task',
      contextMode: 'standard',
      contextProfiles: {},
      contextNotes: '',
      overview: 'Describe what this project does, who it serves, and the product constraints agents should understand before building tasks.',
      goals: [],
      architectureNotes: '',
      codingRules: [
        'Follow existing project patterns before introducing new abstractions.',
        'Keep changes scoped to the active Trellis task.',
        'Do not overwrite unrelated user or agent changes.'
      ],
      agentRules: [
        'Read .agent-board/project.json before claiming or implementing a task.',
        'Use project validationCommands when deciding what to run.',
        'Record any assumptions in the task activityLog or agentNotes.'
      ],
      validationCommands: [],
      approvedValidationCommands: [],
      agentCapabilities: {},
      designRules: [],
      glossary: [],
      inference: await this.buildProjectInference(),
      lastUpdated: new Date().toISOString()
    };
  }

  private async buildProjectInference(): Promise<ProjectInference> {
    const detectedFiles = await this.detectExistingFiles([
      'package.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'package-lock.json',
      'tsconfig.json',
      'vite.config.ts',
      'next.config.js',
      'src/extension.ts',
      'webview/main.tsx'
    ]);
    const scripts = await this.readPackageScripts();
    const likelyStack = new Set<string>();
    if (detectedFiles.includes('package.json')) likelyStack.add('Node.js');
    if (detectedFiles.includes('tsconfig.json')) likelyStack.add('TypeScript');
    if (detectedFiles.includes('src/extension.ts')) likelyStack.add('VS Code Extension API');
    if (detectedFiles.includes('webview/main.tsx')) likelyStack.add('React webview');
    if (detectedFiles.includes('vite.config.ts')) likelyStack.add('Vite');
    if (detectedFiles.includes('next.config.js')) likelyStack.add('Next.js');

    const packageManager = detectedFiles.includes('pnpm-lock.yaml')
      ? 'pnpm'
      : detectedFiles.includes('yarn.lock')
        ? 'yarn'
        : 'npm';
    const suggestedValidation = scripts
      .filter((script) => ['compile', 'typecheck', 'build', 'test', 'lint'].includes(script))
      .map((script) => `${packageManager} run ${script}`);

    return {
      packageManager,
      scripts,
      detectedFiles,
      likelyStack: [...likelyStack],
      suggestedValidation,
      lastInferred: new Date().toISOString()
    };
  }

  private async detectExistingFiles(paths: string[]): Promise<string[]> {
    const found: string[] = [];
    for (const path of paths) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.root, path));
        found.push(path);
      } catch {
        // Missing files are ignored for inference.
      }
    }
    return found;
  }

  private async readPackageScripts(): Promise<string[]> {
    try {
      const packageJson = JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.root, 'package.json')))) as { scripts?: Record<string, string> };
      return Object.keys(packageJson.scripts ?? {}).sort();
    } catch {
      return [];
    }
  }

  private blankTask(id: string): AgentBoardTask {
    const now = new Date().toISOString();
    return {
      id,
      title: '',
      status: 'backlog',
      priority: 'medium',
      assignedAgent: 'unassigned',
      qaAgent: 'unassigned',
      brief: '',
      description: '',
      acceptanceCriteria: [],
      qaChecklist: [],
      designQaChecklist: [],
      validationCommands: [],
      relevantFiles: [],
      constraints: [],
      agentNotes: '',
      qaNotes: [],
      qaEvidence: [],
      activityLog: [{ timestamp: now, actor: 'vscode', message: 'Created blank task.' }],
      comments: [],
      claimedBy: '',
      qaClaimedBy: '',
      branchName: '',
      worktreePath: '',
      claimedAt: '',
      leaseExpiresAt: '',
      claimGeneration: 0,
      dependsOn: [],
      requiredCapabilities: [],
      readyAt: '',
      workflowMode: undefined,
      claimWarning: '',
      lastValidation: null,
      shipResult: null,
      lastUpdated: now
    };
  }

  private async loadTasks(): Promise<AgentBoardTask[]> {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(this.boardDir, 'tasks'));
    const tasks = await Promise.all(entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
      .map(async ([name]) => {
        const fileId = name.slice(0, -'.json'.length);
        assertTaskId(fileId);
        const task = await this.readJson<AgentBoardTask>(vscode.Uri.joinPath(this.boardDir, 'tasks', name));
        if (task.id !== fileId) throw new Error(`Task file ${name} contains mismatched id ${task.id}.`);
        return task;
      }));
    return tasks.map((task) => this.normalizeTask(task)).sort((a, b) => a.id.localeCompare(b.id));
  }

  private async loadArchivedTaskIds(): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(this.boardDir, 'archive'));
      return entries
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
        .map(([name]) => name.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }

  private normalizeTask(task: AgentBoardTask): AgentBoardTask {
    return {
      ...task,
      assignedAgent: this.normalizeAgent(task.assignedAgent),
      qaAgent: this.normalizeAgent(task.qaAgent),
      brief: task.brief ?? '',
      description: task.description ?? '',
      acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [],
      qaChecklist: Array.isArray(task.qaChecklist) ? task.qaChecklist : [],
      designQaChecklist: Array.isArray(task.designQaChecklist) ? task.designQaChecklist : [],
      validationCommands: Array.isArray(task.validationCommands) ? task.validationCommands : [],
      relevantFiles: Array.isArray(task.relevantFiles) ? task.relevantFiles : [],
      constraints: Array.isArray(task.constraints) ? task.constraints : [],
      activityLog: Array.isArray(task.activityLog) ? task.activityLog : [],
      comments: Array.isArray(task.comments) ? task.comments : [],
      qaNotes: Array.isArray(task.qaNotes) ? task.qaNotes : [],
      qaEvidence: Array.isArray(task.qaEvidence) ? task.qaEvidence : [],
      claimedBy: task.claimedBy ?? '',
      qaClaimedBy: task.qaClaimedBy ?? '',
      branchName: task.branchName ?? '',
      worktreePath: task.worktreePath ?? '',
      claimedAt: task.claimedAt ?? '',
      leaseExpiresAt: task.leaseExpiresAt ?? '',
      claimGeneration: Number(task.claimGeneration ?? 0),
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
      requiredCapabilities: Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities : [],
      readyAt: task.readyAt ?? '',
      workflowMode: task.workflowMode === 'direct-on-main' ? 'direct-on-main' : task.workflowMode === 'branch-per-task' ? 'branch-per-task' : undefined,
      claimWarning: task.claimWarning ?? '',
      lastValidation: task.lastValidation ?? null,
      shipResult: task.shipResult ?? null,
      agentNotes: task.agentNotes ?? ''
    };
  }

  private normalizeAgent(agent: unknown): AssignedAgent {
    return agent === 'claude' || agent === 'codex' ? agent : 'unassigned';
  }

  private async loadTasksOrEmpty(): Promise<AgentBoardTask[]> {
    try {
      return await this.loadTasks();
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return [];
      throw error;
    }
  }

  private async appendRootActivity(actor: string, message: string): Promise<void> {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), actor, message }) + '\n';
    const uri = vscode.Uri.joinPath(this.boardDir, 'activity.log');
    let existing = '';
    try {
      existing = decoder.decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      // File will be created below.
    }
    await vscode.workspace.fs.writeFile(uri, encoder.encode(existing + line));
  }

  private async upsertMarkdownSection(uri: vscode.Uri, heading: string, fullContent: string): Promise<void> {
    let existing = '';
    try {
      existing = decoder.decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      await vscode.workspace.fs.writeFile(uri, encoder.encode(fullContent));
      return;
    }

    if (!existing.includes(heading)) {
      const content = existing.trim() === '# Repository Agents' ? fullContent : `${existing.trimEnd()}\n\n${fullContent}`;
      await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
      return;
    }

    const headingStart = existing.indexOf(heading);
    const documentStart = fullContent.startsWith('# Repository Agents') ? existing.indexOf('# Repository Agents') : -1;
    const start = documentStart !== -1 && documentStart < headingStart ? documentStart : headingStart;
    const next = existing.slice(headingStart + heading.length).search(/\n## /);
    const end = next === -1 ? existing.length : headingStart + heading.length + next;
    const replacement = fullContent.trimEnd();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(`${existing.slice(0, start)}${replacement}${existing.slice(end)}`));
  }

  private async ensureDir(uri: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.createDirectory(uri);
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureFile(uri: vscode.Uri, content: string): Promise<void> {
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
    }
  }

  private async readJson<T>(uri: vscode.Uri): Promise<T> {
    return JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(uri))) as T;
  }

  private async writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
    const tmp = uri.with({ path: `${uri.path}.tmp` });
    await vscode.workspace.fs.writeFile(tmp, encoder.encode(`${JSON.stringify(value, null, 2)}\n`));
    await vscode.workspace.fs.rename(tmp, uri, { overwrite: true });
  }
}

function mediaTypeForName(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'md') return 'text/markdown';
  if (extension === 'txt' || extension === 'log') return 'text/plain';
  return 'application/octet-stream';
}

class UriBackedWorkspaceFolder implements vscode.WorkspaceFolder {
  constructor(
    readonly uri: vscode.Uri,
    readonly name: string,
    readonly index: number
  ) {}
}

let cachedStorage: AgentBoardStorage | undefined;

export async function getWorkspaceStorage(): Promise<AgentBoardStorage> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    cachedStorage = new AgentBoardStorage(folder);
    return cachedStorage;
  }

  if (cachedStorage) {
    return cachedStorage;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use Folder for Trellis',
    title: 'Select the repository folder Trellis should use'
  });

  const uri = picked?.[0];
  if (!uri) {
    throw new Error('Select a workspace folder before using Trellis.');
  }

  const name = uri.path.split('/').filter(Boolean).at(-1) ?? 'workspace';
  cachedStorage = new AgentBoardStorage(new UriBackedWorkspaceFolder(uri, name, 0));
  return cachedStorage;
}
