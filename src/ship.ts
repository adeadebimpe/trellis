import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { AgentBoardStorage } from './storage';
import { AgentBoardTask, ShipResult } from './types';

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[], cwd: string, timeout = 60000): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, timeout, maxBuffer: 1024 * 1024 * 5 });
  return stdout.trim();
}

async function tryRun(command: string, args: string[], cwd: string): Promise<string | undefined> {
  try {
    return await run(command, args, cwd);
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error && typeof (error as { stderr: unknown }).stderr === 'string') {
    const stderr = (error as { stderr: string }).stderr.trim();
    if (stderr) {
      return stderr.slice(-500);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export async function shipTask(storage: AgentBoardStorage, task: AgentBoardTask, expectedLastUpdated?: string): Promise<string> {
  const mainRoot = storage.root.fsPath;
  if (task.status !== 'human-review') {
    throw new Error(`Move ${task.id} to Human Review before shipping.`);
  }
  if (!task.branchName) {
    throw new Error(`${task.id} has no task branch to ship.`);
  }
  if (!(await tryRun('git', ['rev-parse', '--is-inside-work-tree'], mainRoot))) {
    throw new Error('Shipping needs a git repository.');
  }

  const worktreePath = task.worktreePath && existsSync(task.worktreePath) ? task.worktreePath : '';
  if (worktreePath) {
    const dirty = await tryRun('git', ['status', '--porcelain'], worktreePath);
    if (dirty) {
      await recordBlocker(storage, task, `Ship blocked: uncommitted changes in the ${task.id} worktree. Commit or discard them first.`, expectedLastUpdated);
      throw new Error(`Ship blocked: the ${task.id} worktree has uncommitted changes.`);
    }
  }

  const originUrl = await tryRun('git', ['remote', 'get-url', 'origin'], mainRoot);
  const useGitHub = Boolean(
    originUrl && originUrl.includes('github.com')
    && await tryRun('gh', ['--version'], mainRoot)
    && (await tryRun('gh', ['auth', 'status'], mainRoot)) !== undefined
  );

  return useGitHub
    ? shipViaPullRequest(storage, task, mainRoot, worktreePath, expectedLastUpdated)
    : shipViaLocalMerge(storage, task, mainRoot, worktreePath, expectedLastUpdated);
}

async function shipViaPullRequest(
  storage: AgentBoardStorage,
  task: AgentBoardTask,
  mainRoot: string,
  worktreePath: string,
  expectedLastUpdated?: string
): Promise<string> {
  try {
    await run('git', ['push', '-u', 'origin', task.branchName], mainRoot, 120000);
  } catch (error) {
    await recordBlocker(storage, task, `Ship blocked: pushing ${task.branchName} failed. ${errorText(error)}`, expectedLastUpdated);
    throw new Error(`Pushing ${task.branchName} failed. ${errorText(error)}`);
  }

  const originHead = await tryRun('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], mainRoot);
  const defaultBranch = originHead?.replace('refs/remotes/origin/', '')
    ?? await tryRun('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], mainRoot)
    ?? 'main';

  const body = [
    task.description || task.brief || task.title || task.id,
    '',
    ...(task.acceptanceCriteria.length ? ['## Acceptance criteria', ...task.acceptanceCriteria.map((item) => `- ${item}`)] : [])
  ].join('\n');

  let prUrl: string;
  try {
    const stdout = await run('gh', ['pr', 'create', '--base', defaultBranch, '--head', task.branchName, '--title', `${task.id}: ${task.title || task.brief.slice(0, 60) || task.id}`, '--body', body], mainRoot, 120000);
    prUrl = stdout.split('\n').reverse().find((line) => line.startsWith('https://')) ?? stdout;
  } catch (error) {
    // A PR for this branch may already exist; recover its URL instead of failing.
    const existing = await tryRun('gh', ['pr', 'view', task.branchName, '--json', 'url', '-q', '.url'], mainRoot);
    if (!existing) {
      await recordBlocker(storage, task, `Ship blocked: gh pr create failed. ${errorText(error)}`, expectedLastUpdated);
      throw new Error(`Creating the pull request failed. ${errorText(error)}`);
    }
    prUrl = existing;
  }

  const worktreeNote = await removeWorktreeSafely(mainRoot, worktreePath);
  const now = new Date().toISOString();
  const shipResult: ShipResult = { mode: 'pr', branch: task.branchName, shippedAt: now, prUrl };
  await storage.saveTask({
    task: {
      id: task.id,
      shipResult,
      worktreePath: '',
      activityLog: [
        ...(task.activityLog ?? []),
        { timestamp: now, actor: 'vscode', message: `Opened pull request ${prUrl} into ${defaultBranch}.${worktreeNote}` }
      ]
    },
    expectedLastUpdated
  });
  return `Pull request created: ${prUrl}. Mark ${task.id} done after merging.`;
}

async function shipViaLocalMerge(
  storage: AgentBoardStorage,
  task: AgentBoardTask,
  mainRoot: string,
  worktreePath: string,
  expectedLastUpdated?: string
): Promise<string> {
  const currentBranch = await tryRun('git', ['symbolic-ref', '--short', 'HEAD'], mainRoot);
  if (!currentBranch) {
    throw new Error('The main checkout is on a detached HEAD; check out the default branch before shipping.');
  }
  const originHead = await tryRun('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], mainRoot);
  const defaultBranch = originHead?.replace('refs/remotes/origin/', '')
    ?? (await tryRun('git', ['rev-parse', '--verify', 'refs/heads/main'], mainRoot) ? 'main'
      : await tryRun('git', ['rev-parse', '--verify', 'refs/heads/master'], mainRoot) ? 'master'
        : currentBranch);
  if (currentBranch !== defaultBranch) {
    throw new Error(`The main checkout is on ${currentBranch}; switch to ${defaultBranch} before shipping.`);
  }

  const status = await tryRun('git', ['status', '--porcelain'], mainRoot) ?? '';
  const blockingChanges = status
    .split('\n')
    .filter(Boolean)
    // Board state files churn constantly and never collide with task branches.
    .filter((line) => !line.slice(3).startsWith('.agent-board'));
  if (blockingChanges.length) {
    throw new Error(`The main checkout has uncommitted changes (${blockingChanges.length} file(s)); commit or stash them before shipping.`);
  }

  try {
    await run('git', ['merge', '--no-ff', task.branchName, '-m', `Merge ${task.branchName} (Trellis ${task.id})`], mainRoot, 120000);
  } catch (error) {
    await tryRun('git', ['merge', '--abort'], mainRoot);
    await recordBlocker(storage, task, `Local merge of ${task.branchName} failed and was aborted. ${errorText(error)}`, expectedLastUpdated);
    throw new Error(`Merging ${task.branchName} failed; the merge was aborted. ${errorText(error)}`);
  }

  const mergeCommit = await tryRun('git', ['rev-parse', 'HEAD'], mainRoot) ?? '';
  const worktreeNote = await removeWorktreeSafely(mainRoot, worktreePath);
  await tryRun('git', ['branch', '-d', task.branchName], mainRoot);
  const now = new Date().toISOString();
  const shipResult: ShipResult = { mode: 'local-merge', branch: task.branchName, shippedAt: now, mergedInto: defaultBranch, mergeCommit };
  await storage.saveTask({
    task: {
      id: task.id,
      status: 'done',
      shipResult,
      worktreePath: '',
      activityLog: [
        ...(task.activityLog ?? []),
        { timestamp: now, actor: 'vscode', message: `Merged ${task.branchName} into ${defaultBranch} (${mergeCommit.slice(0, 8)}).${worktreeNote}` }
      ]
    },
    expectedLastUpdated
  });
  return `${task.id} merged into ${defaultBranch} and marked done.`;
}

async function removeWorktreeSafely(mainRoot: string, worktreePath: string): Promise<string> {
  if (!worktreePath) {
    return '';
  }
  try {
    await run('git', ['worktree', 'remove', worktreePath], mainRoot);
  } catch {
    const status = await tryRun('git', ['status', '--porcelain'], worktreePath);
    const onlyUntracked = status !== undefined && status.split('\n').filter(Boolean).every((line) => line.startsWith('??'));
    if (!onlyUntracked) {
      return ' Worktree was left in place because it has local modifications.';
    }
    try {
      await run('git', ['worktree', 'remove', '--force', worktreePath], mainRoot);
    } catch {
      return ' Worktree could not be removed; clean it up manually.';
    }
  }
  await tryRun('git', ['worktree', 'prune'], mainRoot);
  return ' Removed the task worktree.';
}

async function recordBlocker(storage: AgentBoardStorage, task: AgentBoardTask, message: string, expectedLastUpdated?: string): Promise<void> {
  try {
    await storage.saveTask({
      task: {
        id: task.id,
        activityLog: [...(task.activityLog ?? []), { timestamp: new Date().toISOString(), actor: 'vscode', message }]
      },
      expectedLastUpdated
    });
  } catch {
    // Surfacing the primary error matters more than persisting the blocker note.
  }
}
