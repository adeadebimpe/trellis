export const columns = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'ready-for-agent', title: 'Ready for Agent' },
  { id: 'building', title: 'Building' },
  { id: 'ready-for-qa', title: 'Ready for QA' },
  { id: 'qa-running', title: 'QA Running' },
  { id: 'failed-qa', title: 'Failed QA' },
  { id: 'human-review', title: 'Human Review' },
  { id: 'done', title: 'Done' }
] as const;

export function agentsMarkdown(): string {
  return `# Repository Agents

## Agent Board Workflow

This repository uses Agent Board as the source of truth for AI coding work. Task state lives in \`.agent-board/tasks/*.json\` in the MAIN checkout; do not rely on copied prompts as the durable task record.

Agents should follow this workflow:

1. List \`.agent-board/tasks/\` to see all tasks and read \`.agent-board/project.json\` for project overview, coding rules, agent rules, validation commands, design rules, glossary, and inferred stack context.
2. Find tasks with status \`ready-for-agent\`. Prefer tasks where \`assignedAgent\` is \`codex\` or \`unassigned\`.
3. Claim work with \`node .agent-board/scripts/claim-next-task.mjs codex\` (or \`claim-task.mjs TASK-ID codex\`). The script creates a git worktree at \`.agent-board/worktrees/TASK-ID\` on a task branch and prints the task file path and worktree path.
4. Do ALL code work inside that worktree. Task-state files live only in the MAIN checkout's \`.agent-board/\`; the scripts resolve the main checkout automatically, so run them from anywhere. Never edit \`.agent-board\` files inside a worktree.
5. Read the task JSON printed by the claim script. Implement only that task.
6. Update \`agentNotes\`, \`relevantFiles\`, and append clear entries to \`activityLog\` in the main checkout's task file as work progresses.
7. Commit your work on the task branch inside the worktree.
8. Run \`node .agent-board/scripts/run-validation.mjs TASK-ID\`. This runs the task or project validation commands in the worktree and records evidence on the task. It is required: \`complete-task\` refuses without a passing validation run.
9. Move the task to QA with \`node .agent-board/scripts/complete-task.mjs TASK-ID\`.
10. QA agents claim ready QA work with \`node .agent-board/scripts/start-qa.mjs TASK-ID codex\` (or \`claude\`), review acceptance criteria and changed files in the worktree, re-run \`run-validation.mjs\`, then \`pass-qa.mjs TASK-ID "note"\` or \`fail-qa.mjs TASK-ID "specific failure reason"\`. Passing QA requires the task to be \`qa-running\`, non-empty \`qaEvidence\`, and a passing validation run.
11. If blocked, add a blocker note, append an activity entry, and set \`status\` to \`human-review\`.

Preserve unknown fields in Agent Board JSON files. The scripts take a per-task lock; if you edit task JSON manually, reread the file first and avoid overwriting newer updates from another agent or the VS Code extension.
`;
}

export function claudeSkillMarkdown(): string {
  return `# Agent Board

Use Agent Board when asked to continue project work in this repository.

## Workflow

1. List \`.agent-board/tasks/\` and read \`.agent-board/project.json\` for project overview, rules, validation commands, design rules, glossary, and inferred repo context.
2. Pick the highest-priority task with status \`ready-for-agent\` assigned to \`claude\` or \`unassigned\`.
3. Claim it with \`node .agent-board/scripts/claim-next-task.mjs claude\` (or \`claim-task.mjs TASK-ID claude\`). The script creates a git worktree at \`.agent-board/worktrees/TASK-ID\` on a task branch and prints the task file path and worktree path.
4. Do ALL code work inside that worktree. Task-state files live only in the MAIN checkout's \`.agent-board/\`; the scripts resolve the main checkout automatically. Never edit \`.agent-board\` files inside a worktree.
5. Build according to the project context, task description, acceptance criteria, constraints, and QA checklist.
6. Update \`relevantFiles\`, \`agentNotes\`, and append concise \`activityLog\` entries in the main checkout's task file as work progresses.
7. Commit your work on the task branch inside the worktree.
8. Run \`node .agent-board/scripts/run-validation.mjs TASK-ID\` — it runs the validation commands in the worktree and records evidence. \`complete-task\` refuses without a passing validation run.
9. Move the task to QA with \`node .agent-board/scripts/complete-task.mjs TASK-ID\`.
10. If acting as QA agent, claim ready QA work with \`node .agent-board/scripts/start-qa.mjs TASK-ID claude\`, check acceptance criteria, QA checklist, design QA checklist, and changed files in the worktree, re-run \`run-validation.mjs\`, then \`pass-qa.mjs TASK-ID "note"\` or \`fail-qa.mjs TASK-ID "reason"\`.
11. Move the task to \`human-review\` if blocked or uncertain.

The main checkout's \`.agent-board/\` folder is the source of truth. Preserve unknown fields; the scripts lock tasks while writing, so prefer them over manual JSON edits.
`;
}

export function boardLibScript(): string {
  return `#!/usr/bin/env node
// Shared helpers for Agent Board scripts. Task state always lives in the MAIN
// git worktree's .agent-board/, no matter which worktree a script runs from.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function isGitRepo(cwd) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

export function resolveMainRoot(startDir = process.cwd()) {
  if (isGitRepo(startDir)) {
    try {
      const porcelain = git(['worktree', 'list', '--porcelain'], startDir);
      const first = porcelain.split('\\n').find((line) => line.startsWith('worktree '));
      if (first) {
        const mainPath = first.slice('worktree '.length).trim();
        if (existsSync(join(mainPath, '.agent-board'))) {
          return mainPath;
        }
      }
    } catch {
      // Fall through to directory walk.
    }
  }
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, '.agent-board'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(startDir);
    }
    dir = parent;
  }
}

export function taskPath(mainRoot, taskId) {
  return join(mainRoot, '.agent-board', 'tasks', taskId + '.json');
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeJson(path, value) {
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\\n');
  await rename(tmp, path);
}

function sleep(ms) {
  return new Promise((resolveDone) => setTimeout(resolveDone, ms));
}

export async function acquireLock(mainRoot, key, owner) {
  const locksDir = join(mainRoot, '.agent-board', 'locks');
  mkdirSync(locksDir, { recursive: true });
  const lockDir = join(locksDir, key);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ owner, pid: process.pid, acquiredAt: new Date().toISOString() }));
      return lockDir;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        continue; // Lock vanished between mkdir and stat; retry immediately.
      }
      if (ageMs > LOCK_STALE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
        continue; // Exactly one stealer wins the next mkdir.
      }
      if (Date.now() > deadline) {
        let holder = 'unknown';
        try {
          holder = await readFile(join(lockDir, 'owner.json'), 'utf8');
        } catch {
          // Keep 'unknown'.
        }
        throw new Error('Could not lock ' + key + ' within ' + LOCK_TIMEOUT_MS + 'ms. Held by: ' + holder);
      }
      await sleep(100 + Math.floor(Math.random() * 150));
    }
  }
}

export function releaseLock(lockDir) {
  rmSync(lockDir, { recursive: true, force: true });
}

export async function withTaskLock(mainRoot, key, owner, fn) {
  const lockDir = await acquireLock(mainRoot, key, owner);
  try {
    return await fn();
  } finally {
    releaseLock(lockDir);
  }
}

export function slug(value) {
  return String(value || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
}

export function ensureWorktree(mainRoot, task) {
  const branchName = task.branchName || 'agent-board/' + task.id + '-' + slug(task.title);
  if (!isGitRepo(mainRoot)) {
    return { branchName, worktreePath: '', message: 'Claimed task. No worktree was created because this folder is not a Git repository.' };
  }
  try {
    const porcelain = git(['worktree', 'list', '--porcelain'], mainRoot);
    for (const block of porcelain.split('\\n\\n')) {
      if (block.includes('branch refs/heads/' + branchName)) {
        const line = block.split('\\n').find((entry) => entry.startsWith('worktree '));
        if (line) {
          const existingPath = line.slice('worktree '.length).trim();
          return { branchName, worktreePath: existingPath, message: 'Reusing existing worktree at ' + existingPath + ' on branch ' + branchName + '.' };
        }
      }
    }
    const worktreePath = join(mainRoot, '.agent-board', 'worktrees', task.id);
    mkdirSync(join(mainRoot, '.agent-board', 'worktrees'), { recursive: true });
    let branchExists = true;
    try {
      git(['rev-parse', '--verify', 'refs/heads/' + branchName], mainRoot);
    } catch {
      branchExists = false;
    }
    if (branchExists) {
      git(['worktree', 'add', worktreePath, branchName], mainRoot);
      return { branchName, worktreePath, message: 'Created worktree at ' + worktreePath + ' on existing branch ' + branchName + '.' };
    }
    git(['worktree', 'add', '-b', branchName, worktreePath], mainRoot);
    return { branchName, worktreePath, message: 'Created worktree at ' + worktreePath + ' on new branch ' + branchName + '.' };
  } catch (error) {
    return { branchName, worktreePath: '', message: 'Claimed task, but worktree creation failed: ' + (error && error.message ? error.message : String(error)) };
  }
}

export function fail(exitCode, message) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

export async function runScript(main) {
  try {
    await main();
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exit(typeof error?.exitCode === 'number' ? error.exitCode : 1);
  }
}
`;
}

export function claimNextTaskScript(): string {
  return `#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureWorktree, fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const agent = process.argv[2];
  if (!agent || !['claude', 'codex'].includes(agent)) {
    throw fail(1, 'Usage: node .agent-board/scripts/claim-next-task.mjs claude|codex');
  }

  const mainRoot = resolveMainRoot();
  const tasksDir = join(mainRoot, '.agent-board', 'tasks');
  const priorityRank = { high: 0, medium: 1, low: 2 };

  const files = (await readdir(tasksDir)).filter((file) => file.endsWith('.json'));
  const tasks = await Promise.all(files.map((file) => readJson(join(tasksDir, file))));

  const candidates = tasks
    .filter((task) => task.status === 'ready-for-agent' && (task.assignedAgent === agent || task.assignedAgent === 'unassigned'))
    .sort((a, b) => {
      const priorityDelta = (priorityRank[a.priority] ?? 99) - (priorityRank[b.priority] ?? 99);
      return priorityDelta || String(a.id).localeCompare(String(b.id));
    });

  for (const candidate of candidates) {
    const path = taskPath(mainRoot, candidate.id);
    const claimed = await withTaskLock(mainRoot, candidate.id, agent, async () => {
      const task = await readJson(path);
      if (task.status !== 'ready-for-agent' || (task.assignedAgent !== agent && task.assignedAgent !== 'unassigned')) {
        return null; // Lost the race; try the next candidate.
      }
      const now = new Date().toISOString();
      const worktree = ensureWorktree(mainRoot, task);
      task.status = 'building';
      task.assignedAgent = agent;
      task.claimedBy = agent;
      task.branchName = worktree.branchName;
      task.worktreePath = worktree.worktreePath;
      task.claimedAt = now;
      task.lastUpdated = now;
      task.activityLog = Array.isArray(task.activityLog) ? task.activityLog : [];
      task.activityLog.push({ timestamp: now, actor: agent, message: worktree.message });
      await writeJson(path, task);
      return task;
    });
    if (claimed) {
      console.log(JSON.stringify({ task: claimed, taskFile: path, worktreePath: claimed.worktreePath }, null, 2));
      return;
    }
  }

  throw fail(2, 'No ready task found for ' + agent + '.');
});
`;
}

export function claimTaskScript(): string {
  return `#!/usr/bin/env node
import { ensureWorktree, fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, agent] = process.argv.slice(2);
  if (!taskId || !agent || !['claude', 'codex'].includes(agent)) {
    throw fail(1, 'Usage: node .agent-board/scripts/claim-task.mjs TASK-001 claude|codex');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, taskId, agent, async () => {
    const current = await readJson(path);
    if (current.status !== 'ready-for-agent' && current.status !== 'building') {
      throw fail(2, 'Task must be ready-for-agent before build can start.');
    }
    if (current.assignedAgent && current.assignedAgent !== 'unassigned' && current.assignedAgent !== agent) {
      throw fail(3, 'Task is assigned to ' + current.assignedAgent + ', not ' + agent + '.');
    }
    const now = new Date().toISOString();
    const worktree = ensureWorktree(mainRoot, current);
    current.status = 'building';
    current.assignedAgent = agent;
    current.claimedBy = agent;
    current.branchName = worktree.branchName;
    current.worktreePath = worktree.worktreePath;
    current.claimedAt = now;
    current.lastUpdated = now;
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor: agent, message: worktree.message });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify({ task, taskFile: path, worktreePath: task.worktreePath }, null, 2));
});
`;
}

export function completeTaskScript(): string {
  return `#!/usr/bin/env node
import { fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const taskId = process.argv[2];
  if (!taskId) {
    throw fail(1, 'Usage: node .agent-board/scripts/complete-task.mjs TASK-001');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, taskId, 'complete-task', async () => {
    const current = await readJson(path);
    if (current.status !== 'building') {
      throw fail(2, 'Task must be building to complete. Current status: ' + current.status + '.');
    }
    if (!current.lastValidation || !current.lastValidation.passed) {
      throw fail(3, 'Validation has not passed. Run: node .agent-board/scripts/run-validation.mjs ' + taskId);
    }
    if (current.claimedAt && current.lastValidation.ranAt <= current.claimedAt) {
      throw fail(3, 'Validation is older than the current claim. Re-run: node .agent-board/scripts/run-validation.mjs ' + taskId);
    }
    const now = new Date().toISOString();
    const actor = current.claimedBy || 'agent';
    current.status = 'ready-for-qa';
    current.lastUpdated = now;
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor, message: 'Moved task to ready-for-qa.' });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify(task, null, 2));
});
`;
}

export function startQaScript(): string {
  return `#!/usr/bin/env node
import { ensureWorktree, fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, agent = 'qa'] = process.argv.slice(2);
  if (!taskId) {
    throw fail(1, 'Usage: node .agent-board/scripts/start-qa.mjs TASK-001 codex|claude');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, taskId, agent, async () => {
    const current = await readJson(path);
    if (current.status !== 'ready-for-qa' && current.status !== 'failed-qa') {
      throw fail(2, 'Task must be ready-for-qa or failed-qa before QA can start.');
    }
    const now = new Date().toISOString();
    const worktree = ensureWorktree(mainRoot, current);
    current.status = 'qa-running';
    current.qaClaimedBy = agent;
    current.qaAgent = current.qaAgent && current.qaAgent !== 'unassigned' ? current.qaAgent : (['claude', 'codex'].includes(agent) ? agent : 'unassigned');
    current.branchName = worktree.branchName;
    current.worktreePath = worktree.worktreePath;
    current.lastUpdated = now;
    current.qaNotes = Array.isArray(current.qaNotes) ? current.qaNotes : [];
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor: agent, message: 'Started QA. ' + worktree.message });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify({ task, taskFile: path, worktreePath: task.worktreePath }, null, 2));
});
`;
}

export function runValidationScript(): string {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

function runCommand(command, cwd) {
  return new Promise((resolveDone) => {
    const child = spawn(command, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let done = false;
    const finish = (exitCode) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveDone({ exitCode, output });
    };
    const timer = setTimeout(() => {
      output += '\\n[run-validation] Timed out after ' + COMMAND_TIMEOUT_MS / 1000 + 's.';
      child.kill('SIGTERM');
      finish(124);
    }, COMMAND_TIMEOUT_MS);
    const capture = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 200000) {
        output = output.slice(-100000);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => {
      output += String(error);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

await runScript(async () => {
  const taskId = process.argv[2];
  if (!taskId) {
    throw fail(1, 'Usage: node .agent-board/scripts/run-validation.mjs TASK-001');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);
  const task = await readJson(path);
  let project = {};
  try {
    project = await readJson(join(mainRoot, '.agent-board', 'project.json'));
  } catch {
    // Project context is optional here.
  }

  const commands = Array.isArray(task.validationCommands) && task.validationCommands.length
    ? task.validationCommands
    : Array.isArray(project.validationCommands) && project.validationCommands.length
      ? project.validationCommands
      : project.inference?.suggestedValidation ?? [];

  if (!commands.length) {
    throw fail(2, 'No validation commands configured on the task or project. Add validationCommands first.');
  }

  const cwd = task.worktreePath || mainRoot;
  console.log('Running ' + commands.length + ' validation command(s) in ' + cwd);
  const results = [];
  for (const command of commands) {
    const startedAt = Date.now();
    const result = await runCommand(command, cwd);
    results.push({ command, exitCode: result.exitCode, durationMs: Date.now() - startedAt, outputTail: result.output.slice(-2000) });
    console.log((result.exitCode === 0 ? '[PASS] ' : '[FAIL exit ' + result.exitCode + '] ') + command);
  }

  const passed = results.every((result) => result.exitCode === 0);
  const ranAt = new Date().toISOString();

  await withTaskLock(mainRoot, taskId, 'run-validation', async () => {
    const fresh = await readJson(path);
    fresh.lastValidation = { ranAt, passed, results };
    fresh.qaEvidence = Array.isArray(fresh.qaEvidence) ? fresh.qaEvidence : [];
    for (const result of results) {
      fresh.qaEvidence.push((result.exitCode === 0 ? 'PASS' : 'FAIL (exit ' + result.exitCode + ')') + ': ' + result.command);
    }
    fresh.activityLog = Array.isArray(fresh.activityLog) ? fresh.activityLog : [];
    fresh.activityLog.push({
      timestamp: ranAt,
      actor: fresh.claimedBy || fresh.qaClaimedBy || 'agent',
      message: 'Ran validation: ' + results.length + ' command(s), ' + (passed ? 'all passed.' : 'FAILED.')
    });
    fresh.lastUpdated = ranAt;
    await writeJson(path, fresh);
  });

  if (!passed) {
    throw fail(3, 'Validation failed. See task qaEvidence and lastValidation for details.');
  }
});
`;
}

export function passQaScript(): string {
  return `#!/usr/bin/env node
import { fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, ...noteParts] = process.argv.slice(2);
  const note = noteParts.join(' ').trim() || 'QA passed.';
  if (!taskId) {
    throw fail(1, 'Usage: node .agent-board/scripts/pass-qa.mjs TASK-001 "optional note"');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, taskId, 'pass-qa', async () => {
    const current = await readJson(path);
    if (current.status !== 'qa-running') {
      throw fail(2, 'Task must be qa-running to pass QA. Current status: ' + current.status + '. Run start-qa.mjs first.');
    }
    if (!Array.isArray(current.qaEvidence) || current.qaEvidence.length === 0) {
      throw fail(3, 'qaEvidence is empty. Run run-validation.mjs and record QA evidence before passing.');
    }
    if (!current.lastValidation || !current.lastValidation.passed) {
      throw fail(4, 'Validation has not passed. Run: node .agent-board/scripts/run-validation.mjs ' + taskId);
    }
    const now = new Date().toISOString();
    const actor = current.qaClaimedBy || current.qaAgent || 'qa';
    current.status = 'human-review';
    current.lastUpdated = now;
    current.qaNotes = Array.isArray(current.qaNotes) ? current.qaNotes : [];
    current.qaNotes.push({ timestamp: now, actor, message: note });
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor, message: 'QA passed. Moved task to human-review.' });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify(task, null, 2));
});
`;
}

export function failQaScript(): string {
  return `#!/usr/bin/env node
import { fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, ...reasonParts] = process.argv.slice(2);
  const reason = reasonParts.join(' ').trim();
  if (!taskId || !reason) {
    throw fail(1, 'Usage: node .agent-board/scripts/fail-qa.mjs TASK-001 "failure reason"');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, taskId, 'fail-qa', async () => {
    const current = await readJson(path);
    const now = new Date().toISOString();
    const actor = current.qaClaimedBy || current.qaAgent || 'qa';
    current.status = 'failed-qa';
    current.lastUpdated = now;
    current.qaNotes = Array.isArray(current.qaNotes) ? current.qaNotes : [];
    current.qaNotes.push({ timestamp: now, actor, message: reason });
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor, message: 'QA failed: ' + reason });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify(task, null, 2));
});
`;
}

export function boardGitignore(): string {
  return `activity.log
worktrees/
locks/
prompts/
board.json
*.tmp
`;
}
