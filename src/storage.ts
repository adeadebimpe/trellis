import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { agentsMarkdown, boardGitignore, boardLibScript, claimNextTaskScript, claimTaskScript, claudeSkillMarkdown, columns, completeTaskScript, failQaScript, passQaScript, runValidationScript, startQaScript } from './agentFiles';
import { withLock } from './locks';
import { deriveTaskTitle } from './prdPrompt';
import { AgentBoardFile, AgentBoardTask, AssignedAgent, ProjectContext, ProjectInference, SaveTaskRequest, TaskStatus } from './types';

const execFileAsync = promisify(execFile);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

  async prepareAgentFiles(): Promise<void> {
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
      const nextNumber = tasks
        .map((task) => Number(task.id.replace(/^TASK-/, '')))
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
      const task = await this.readJson<AgentBoardTask>(this.taskUri(id));
      if (task.status !== 'done') {
        throw new Error(`Only done tasks can be archived. ${id} is ${task.status}.`);
      }
      await vscode.workspace.fs.rename(this.taskUri(id), vscode.Uri.joinPath(this.boardDir, 'archive', `${id}.json`), { overwrite: true });
    });
    await this.appendRootActivity('vscode', `Archived ${id}.`);
  }

  async removeWorktree(worktreePath: string): Promise<void> {
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
      lastUpdated: new Date().toISOString()
    };
    await this.writeJson(this.projectUri(), merged);
    await this.appendRootActivity('vscode', 'Inferred project context.');
    return merged;
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
      contextNotes: '',
      overview: 'Describe what this project does, who it serves, and the product constraints agents should understand before building tasks.',
      goals: [],
      architectureNotes: '',
      codingRules: [
        'Follow existing project patterns before introducing new abstractions.',
        'Keep changes scoped to the active Agent Board task.',
        'Do not overwrite unrelated user or agent changes.'
      ],
      agentRules: [
        'Read .agent-board/project.json before claiming or implementing a task.',
        'Use project validationCommands when deciding what to run.',
        'Record any assumptions in the task activityLog or agentNotes.'
      ],
      validationCommands: [],
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
      claimedBy: '',
      qaClaimedBy: '',
      branchName: '',
      worktreePath: '',
      claimedAt: '',
      lastValidation: null,
      shipResult: null,
      lastUpdated: now
    };
  }

  private async loadTasks(): Promise<AgentBoardTask[]> {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(this.boardDir, 'tasks'));
    const tasks = await Promise.all(entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
      .map(([name]) => this.readJson<AgentBoardTask>(vscode.Uri.joinPath(this.boardDir, 'tasks', name))));
    return tasks.map((task) => this.normalizeTask(task)).sort((a, b) => a.id.localeCompare(b.id));
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
      qaNotes: Array.isArray(task.qaNotes) ? task.qaNotes : [],
      qaEvidence: Array.isArray(task.qaEvidence) ? task.qaEvidence : [],
      claimedBy: task.claimedBy ?? '',
      qaClaimedBy: task.qaClaimedBy ?? '',
      branchName: task.branchName ?? '',
      worktreePath: task.worktreePath ?? '',
      claimedAt: task.claimedAt ?? '',
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
    } catch {
      return [];
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
    openLabel: 'Use Folder for Agent Board',
    title: 'Select the repository folder Agent Board should use'
  });

  const uri = picked?.[0];
  if (!uri) {
    throw new Error('Select a workspace folder before using Agent Board.');
  }

  const name = uri.path.split('/').filter(Boolean).at(-1) ?? 'workspace';
  cachedStorage = new AgentBoardStorage(new UriBackedWorkspaceFolder(uri, name, 0));
  return cachedStorage;
}
