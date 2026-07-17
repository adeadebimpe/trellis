import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outfile = '/private/tmp/agent-board-agentFiles.cjs';
execFileSync('./node_modules/.bin/esbuild', [
  'src/agentFiles.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${outfile}`
], { stdio: 'inherit' });

const require = createRequire(import.meta.url);
const templates = require(outfile);

function blankTask(id, overrides = {}) {
  const now = '2026-07-01T00:00:00.000Z';
  return {
    id,
    title: `Task ${id}`,
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
    activityLog: [],
    claimedBy: '',
    qaClaimedBy: '',
    branchName: '',
    worktreePath: '',
    claimedAt: '',
    lastValidation: null,
    shipResult: null,
    lastUpdated: now,
    ...overrides
  };
}

function scaffoldBoard(root, tasks) {
  const boardDir = join(root, '.agent-board');
  for (const dir of ['tasks', 'scripts', 'locks', 'worktrees']) {
    mkdirSync(join(boardDir, dir), { recursive: true });
  }
  writeFileSync(join(boardDir, '.gitignore'), templates.boardGitignore());
  writeFileSync(join(boardDir, 'project.json'), JSON.stringify({
    version: 1,
    validationCommands: [],
    inference: { suggestedValidation: [] }
  }, null, 2));
  const scripts = {
    '_lib.mjs': templates.boardLibScript(),
    'claim-task.mjs': templates.claimTaskScript(),
    'claim-next-task.mjs': templates.claimNextTaskScript(),
    'complete-task.mjs': templates.completeTaskScript(),
    'start-qa.mjs': templates.startQaScript(),
    'run-validation.mjs': templates.runValidationScript(),
    'pass-qa.mjs': templates.passQaScript(),
    'fail-qa.mjs': templates.failQaScript()
  };
  for (const [name, content] of Object.entries(scripts)) {
    writeFileSync(join(boardDir, 'scripts', name), content);
  }
  for (const task of tasks) {
    writeFileSync(join(boardDir, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
  }
}

function runScript(root, script, args, cwd = root) {
  return spawnSync('node', [join(root, '.agent-board', 'scripts', script), ...args], { cwd, encoding: 'utf8', timeout: 60000 });
}

function readTask(root, id) {
  return JSON.parse(readFileSync(join(root, '.agent-board', 'tasks', `${id}.json`), 'utf8'));
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

const cleanups = [];

// --- Fixture A: a real git repo ---
// realpath: git reports /private/var/... on macOS while mkdtemp returns the /var symlink.
const repo = await realpath(await mkdtemp(join(tmpdir(), 'agent-board-scripts-')));
cleanups.push(repo);
git(repo, ['init', '-b', 'main']);
git(repo, ['config', 'user.email', 'test@example.com']);
git(repo, ['config', 'user.name', 'Test']);
writeFileSync(join(repo, 'README.md'), 'fixture\n');
scaffoldBoard(repo, [
  blankTask('TASK-001', { status: 'ready-for-agent', validationCommands: ['node -e "process.exit(0)"'] }),
  blankTask('TASK-002', { status: 'ready-for-qa', validationCommands: ['node -e "process.exit(1)"'] }),
  blankTask('TASK-003', { status: 'ready-for-agent' }),
  blankTask('TASK-004', { status: 'ready-for-agent', priority: 'high' }),
  blankTask('TASK-005', { status: 'ready-for-agent', priority: 'medium' })
]);
git(repo, ['add', '-A']);
git(repo, ['commit', '-q', '-m', 'fixture']);

// Claim creates a worktree and writes state to the main checkout only.
let result = runScript(repo, 'claim-task.mjs', ['TASK-001', 'claude']);
assert.equal(result.status, 0, result.stderr);
const claimOutput = JSON.parse(result.stdout);
const task1 = readTask(repo, 'TASK-001');
assert.equal(task1.status, 'building');
assert.equal(task1.claimedBy, 'claude');
assert.ok(task1.claimedAt);
assert.equal(task1.worktreePath, join(repo, '.agent-board', 'worktrees', 'TASK-001'));
assert.equal(claimOutput.worktreePath, task1.worktreePath);
assert.ok(existsSync(task1.worktreePath));
assert.match(git(repo, ['worktree', 'list']), /agent-board\/TASK-001/);
const worktreeCopy = JSON.parse(readFileSync(join(task1.worktreePath, '.agent-board', 'tasks', 'TASK-001.json'), 'utf8'));
assert.equal(worktreeCopy.status, 'ready-for-agent', 'task state must not leak into the worktree checkout');

// complete-task refuses without a validation run.
result = runScript(repo, 'complete-task.mjs', ['TASK-001']);
assert.equal(result.status, 3, 'complete-task must refuse before validation');
assert.match(result.stderr, /run-validation/);

// run-validation FROM INSIDE THE WORKTREE still writes to the main checkout.
result = runScript(repo, 'run-validation.mjs', ['TASK-001'], task1.worktreePath);
assert.equal(result.status, 0, result.stderr);
const validated = readTask(repo, 'TASK-001');
assert.equal(validated.lastValidation.passed, true);
assert.equal(validated.lastValidation.results.length, 1);
assert.ok(validated.qaEvidence.length > 0);

// Now complete-task succeeds.
result = runScript(repo, 'complete-task.mjs', ['TASK-001']);
assert.equal(result.status, 0, result.stderr);
assert.equal(readTask(repo, 'TASK-001').status, 'ready-for-qa');

// pass-qa refuses outside qa-running.
result = runScript(repo, 'pass-qa.mjs', ['TASK-001', 'looks good']);
assert.equal(result.status, 2, 'pass-qa must refuse before start-qa');

result = runScript(repo, 'start-qa.mjs', ['TASK-001', 'codex']);
assert.equal(result.status, 0, result.stderr);
assert.equal(readTask(repo, 'TASK-001').status, 'qa-running');

result = runScript(repo, 'pass-qa.mjs', ['TASK-001', 'looks good']);
assert.equal(result.status, 0, result.stderr);
assert.equal(readTask(repo, 'TASK-001').status, 'human-review');

// TASK-002: empty evidence, then failing validation.
result = runScript(repo, 'start-qa.mjs', ['TASK-002', 'claude']);
assert.equal(result.status, 0, result.stderr);
result = runScript(repo, 'pass-qa.mjs', ['TASK-002']);
assert.equal(result.status, 3, 'pass-qa must refuse with empty qaEvidence');
result = runScript(repo, 'run-validation.mjs', ['TASK-002']);
assert.equal(result.status, 3, 'run-validation must exit non-zero on failure');
const failedValidation = readTask(repo, 'TASK-002');
assert.equal(failedValidation.lastValidation.passed, false);
result = runScript(repo, 'pass-qa.mjs', ['TASK-002']);
assert.equal(result.status, 4, 'pass-qa must refuse when validation failed');
result = runScript(repo, 'fail-qa.mjs', ['TASK-002', 'validation failed']);
assert.equal(result.status, 0, result.stderr);
assert.equal(readTask(repo, 'TASK-002').status, 'failed-qa');

// Locking: a fresh lock blocks the claim; a stale lock (>30s) is stolen.
const lockDir = join(repo, '.agent-board', 'locks', 'TASK-003');
mkdirSync(lockDir, { recursive: true });
writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ owner: 'other-agent' }));
result = runScript(repo, 'claim-task.mjs', ['TASK-003', 'claude']);
assert.notEqual(result.status, 0, 'claim must time out while the lock is held');
assert.match(result.stderr, /Could not lock/);
const past = new Date(Date.now() - 60000);
utimesSync(lockDir, past, past);
result = runScript(repo, 'claim-task.mjs', ['TASK-003', 'claude']);
assert.equal(result.status, 0, `stale lock must be stolen: ${result.stderr}`);
assert.equal(readTask(repo, 'TASK-003').status, 'building');

// claim-next picks the highest-priority ready task.
result = runScript(repo, 'claim-next-task.mjs', ['claude']);
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).task.id, 'TASK-004');
assert.equal(readTask(repo, 'TASK-004').status, 'building');
assert.equal(readTask(repo, 'TASK-005').status, 'ready-for-agent');

writeFileSync(join(repo, '.agent-board', 'tasks', 'TASK-005.json'), JSON.stringify({ ...readTask(repo, 'TASK-005'), status: 'backlog' }, null, 2));
result = runScript(repo, 'claim-next-task.mjs', ['claude']);
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).noTask, true);

// --- Fixture B: not a git repo ---
const plain = await mkdtemp(join(tmpdir(), 'agent-board-plain-'));
cleanups.push(plain);
scaffoldBoard(plain, [blankTask('TASK-001', { status: 'ready-for-agent' })]);
result = runScript(plain, 'claim-task.mjs', ['TASK-001', 'codex']);
assert.equal(result.status, 0, result.stderr);
const plainTask = readTask(plain, 'TASK-001');
assert.equal(plainTask.status, 'building');
assert.equal(plainTask.worktreePath, '');

for (const dir of cleanups) {
  await rm(dir, { recursive: true, force: true });
}

console.log('Agent Board script tests passed.');
