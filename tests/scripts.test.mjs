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

function scaffoldBoard(root, tasks, projectOverrides = {}) {
  const boardDir = join(root, '.agent-board');
  for (const dir of ['tasks', 'scripts', 'locks', 'worktrees']) {
    mkdirSync(join(boardDir, dir), { recursive: true });
  }
  writeFileSync(join(boardDir, '.gitignore'), templates.boardGitignore());
  writeFileSync(join(boardDir, 'project.json'), JSON.stringify({
    version: 1,
    validationCommands: [],
    approvedValidationCommands: [...new Set(tasks.flatMap((task) => task.validationCommands ?? []))],
    inference: { suggestedValidation: [] },
    ...projectOverrides
  }, null, 2));
  const scripts = {
    '_lib.mjs': templates.boardLibScript(),
    'claim-task.mjs': templates.claimTaskScript(),
    'claim-next-task.mjs': templates.claimNextTaskScript(),
    'heartbeat-task.mjs': templates.heartbeatTaskScript(),
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
  blankTask('TASK-005', { status: 'ready-for-agent', priority: 'medium' }),
  blankTask('TASK-006', { status: 'ready-for-agent', branchName: 'invalid branch name' }),
  blankTask('TASK-007', { status: 'ready-for-agent' })
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
assert.ok(task1.claimId);
assert.equal(task1.worktreePath, join(repo, '.agent-board', 'worktrees', 'TASK-001'));
assert.equal(claimOutput.worktreePath, task1.worktreePath);
assert.ok(existsSync(task1.worktreePath));
assert.match(git(repo, ['worktree', 'list']), /agent-board\/TASK-001/);
const worktreeCopy = JSON.parse(readFileSync(join(task1.worktreePath, '.agent-board', 'tasks', 'TASK-001.json'), 'utf8'));
assert.equal(worktreeCopy.status, 'ready-for-agent', 'task state must not leak into the worktree checkout');

// A second session cannot re-claim an active build, even when it uses the same agent type.
result = runScript(repo, 'claim-task.mjs', ['TASK-001', 'claude']);
assert.equal(result.status, 2, 'an active build must not be claimed twice');

// A Git worktree failure leaves the task ready instead of silently falling back to main.
result = runScript(repo, 'claim-task.mjs', ['TASK-006', 'claude']);
assert.equal(result.status, 4, 'worktree creation failure must fail the claim');
assert.equal(readTask(repo, 'TASK-006').status, 'ready-for-agent');
assert.equal(readTask(repo, 'TASK-006').worktreePath, '');
writeFileSync(join(repo, '.agent-board', 'tasks', 'TASK-006.json'), JSON.stringify({ ...readTask(repo, 'TASK-006'), status: 'backlog' }, null, 2));

// QA failure is only valid for an actively claimed QA run.
result = runScript(repo, 'fail-qa.mjs', ['TASK-005', 'not actually in QA']);
assert.equal(result.status, 2, 'fail-qa must reject non-QA tasks');
assert.equal(readTask(repo, 'TASK-005').status, 'ready-for-agent');

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
assert.equal(validated.lastValidation.claimId, task1.claimId);
assert.equal(validated.lastValidation.phase, 'build');

// A passing result is invalid once the tested code changes.
writeFileSync(join(task1.worktreePath, 'README.md'), 'changed after validation\n');
result = runScript(repo, 'complete-task.mjs', ['TASK-001']);
assert.equal(result.status, 3, 'completion must reject code changed after validation');
writeFileSync(join(task1.worktreePath, 'README.md'), 'fixture\n');

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
assert.equal(result.status, 4, 'QA must not reuse build validation');
result = runScript(repo, 'run-validation.mjs', ['TASK-001']);
assert.equal(result.status, 0, result.stderr);
result = runScript(repo, 'pass-qa.mjs', ['TASK-001', 'looks good']);
assert.equal(result.status, 0, result.stderr);
assert.equal(readTask(repo, 'TASK-001').status, 'done');

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

// A stale-looking lock owned by a live process must not be stolen.
const liveLockDir = join(repo, '.agent-board', 'locks', 'TASK-007');
mkdirSync(liveLockDir, { recursive: true });
writeFileSync(join(liveLockDir, 'owner.json'), JSON.stringify({ owner: 'live-agent', token: 'live-token', pid: process.pid }));
utimesSync(liveLockDir, past, past);
result = runScript(repo, 'claim-task.mjs', ['TASK-007', 'claude']);
assert.notEqual(result.status, 0, 'a live owner must retain a stale-looking lock');
assert.match(result.stderr, /Could not lock/);
await rm(liveLockDir, { recursive: true, force: true });
writeFileSync(join(repo, '.agent-board', 'tasks', 'TASK-007.json'), JSON.stringify({ ...readTask(repo, 'TASK-007'), status: 'backlog' }, null, 2));

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

// Task IDs cannot escape the task directory.
const projectBeforeTraversal = readFileSync(join(repo, '.agent-board', 'project.json'), 'utf8');
result = runScript(repo, 'claim-task.mjs', ['../project', 'claude']);
assert.equal(result.status, 1, 'path-traversing task IDs must be rejected');
assert.match(result.stderr, /Invalid task ID/);
assert.equal(readFileSync(join(repo, '.agent-board', 'project.json'), 'utf8'), projectBeforeTraversal);

// claim-next validates the filename against the embedded ID before selecting work.
writeFileSync(join(repo, '.agent-board', 'tasks', 'TASK-008.json'), JSON.stringify(blankTask('TASK-009', { status: 'ready-for-agent' }), null, 2));
result = runScript(repo, 'claim-next-task.mjs', ['claude']);
assert.equal(result.status, 0, 'a mismatched task file must not block healthy scheduling');
assert.match(result.stderr, /\[SKIP\] TASK-008\.json.*does not match filename/);

// --- Fixture B: not a git repo ---
const plain = await mkdtemp(join(tmpdir(), 'agent-board-plain-'));
cleanups.push(plain);
scaffoldBoard(plain, [blankTask('TASK-001', { status: 'ready-for-agent' })]);
result = runScript(plain, 'claim-task.mjs', ['TASK-001', 'codex']);
assert.equal(result.status, 0, result.stderr);
const plainTask = readTask(plain, 'TASK-001');
assert.equal(plainTask.status, 'building');
assert.equal(plainTask.worktreePath, '');

// --- Fixture C: resilient, dependency/capability-aware scheduling and leases ---
const orchestration = await mkdtemp(join(tmpdir(), 'agent-board-orchestration-'));
cleanups.push(orchestration);
scaffoldBoard(orchestration, [
  blankTask('TASK-001', { status: 'ready-for-agent', priority: 'high', dependsOn: ['TASK-999'] }),
  blankTask('TASK-002', { status: 'ready-for-agent', priority: 'high', requiredCapabilities: ['docker'] }),
  blankTask('TASK-003', { status: 'ready-for-agent', priority: 'low', readyAt: '2026-06-01T00:00:00.000Z', validationCommands: ['node -e "process.exit(0)"'] }),
  blankTask('TASK-004', { status: 'building', assignedAgent: 'codex', priority: 'low', claimedAt: '2026-06-01T00:00:00.000Z', lastUpdated: '2026-07-19T00:00:00.000Z', claimGeneration: 1 })
]);
writeFileSync(join(orchestration, '.agent-board', 'project.json'), JSON.stringify({
  version: 1,
  validationCommands: [],
  approvedValidationCommands: ['node -e "process.exit(0)"'],
  agentCapabilities: { codex: ['typescript'] },
  inference: { suggestedValidation: [] }
}, null, 2));
writeFileSync(join(orchestration, '.agent-board', 'tasks', 'TASK-005.json'), '{ malformed');

result = runScript(orchestration, 'claim-next-task.mjs', ['codex']);
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).task.id, 'TASK-003', 'an aged low-priority task must eventually outrank new work');
assert.match(result.stderr, /\[SKIP\] TASK-005.json/);

result = runScript(orchestration, 'claim-task.mjs', ['TASK-001', 'codex']);
assert.equal(result.status, 5, 'unfinished dependencies must block explicit claims');
result = runScript(orchestration, 'claim-task.mjs', ['TASK-002', 'codex']);
assert.equal(result.status, 5, 'missing capabilities must block explicit claims');

result = runScript(orchestration, 'claim-task.mjs', ['TASK-004', 'codex']);
assert.equal(result.status, 0, result.stderr);
const reclaimed = readTask(orchestration, 'TASK-004');
assert.equal(reclaimed.claimGeneration, 2);
assert.ok(reclaimed.leaseExpiresAt);
const oldLease = reclaimed.leaseExpiresAt;
result = runScript(orchestration, 'heartbeat-task.mjs', ['TASK-004', reclaimed.claimId]);
assert.equal(result.status, 0, result.stderr);
assert.ok(readTask(orchestration, 'TASK-004').leaseExpiresAt >= oldLease);

const marker = join(orchestration, 'unapproved-command-ran');
writeFileSync(join(orchestration, '.agent-board', 'tasks', 'TASK-003.json'), JSON.stringify({
  ...readTask(orchestration, 'TASK-003'),
  validationCommands: [`node -e "require('fs').writeFileSync('${marker}', 'bad')"`]
}, null, 2));
result = runScript(orchestration, 'run-validation.mjs', ['TASK-003']);
assert.equal(result.status, 2, 'unapproved task commands must be refused before execution');
assert.equal(existsSync(marker), false);

// --- Fixture D: direct-on-main mode ---
const direct = await realpath(await mkdtemp(join(tmpdir(), 'agent-board-direct-')));
cleanups.push(direct);
git(direct, ['init', '-b', 'main']);
git(direct, ['config', 'user.email', 'test@example.com']);
git(direct, ['config', 'user.name', 'Test']);
writeFileSync(join(direct, 'README.md'), 'fixture\n');
scaffoldBoard(direct, [
  blankTask('TASK-001', { status: 'ready-for-agent' }),
  blankTask('TASK-002', { status: 'ready-for-agent' })
], { workflowMode: 'direct-on-main' });
git(direct, ['add', '-A']);
git(direct, ['commit', '-q', '-m', 'fixture']);
writeFileSync(join(direct, 'README.md'), 'dirty main\n');

result = runScript(direct, 'claim-task.mjs', ['TASK-001', 'codex']);
assert.equal(result.status, 0, result.stderr);
const directTask = readTask(direct, 'TASK-001');
assert.equal(directTask.workflowMode, 'direct-on-main');
assert.equal(directTask.worktreePath, direct);
assert.equal(directTask.branchName, '');
assert.match(directTask.claimWarning, /uncommitted/);
assert.equal(git(direct, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1, 'direct mode must not add a worktree');

result = runScript(direct, 'claim-task.mjs', ['TASK-002', 'codex']);
assert.equal(result.status, 5, 'direct mode must block a second active build');
assert.equal(readTask(direct, 'TASK-002').status, 'ready-for-agent');

writeFileSync(join(direct, '.agent-board', 'tasks', 'TASK-001.json'), JSON.stringify({ ...readTask(direct, 'TASK-001'), status: 'ready-for-qa' }, null, 2));
result = runScript(direct, 'start-qa.mjs', ['TASK-001', 'codex']);
assert.equal(result.status, 0, result.stderr);
result = runScript(direct, 'claim-task.mjs', ['TASK-002', 'codex']);
assert.equal(result.status, 5, 'direct mode must also block a build while direct QA is active');

// Changing the project mode only affects later claims.
writeFileSync(join(direct, '.agent-board', 'project.json'), JSON.stringify({ workflowMode: 'branch-per-task', validationCommands: [] }, null, 2));
result = runScript(direct, 'claim-task.mjs', ['TASK-002', 'codex']);
assert.equal(result.status, 0, result.stderr);
assert.equal(readTask(direct, 'TASK-001').workflowMode, 'direct-on-main');
assert.equal(readTask(direct, 'TASK-002').workflowMode, 'branch-per-task');
assert.ok(readTask(direct, 'TASK-002').worktreePath.includes('.agent-board/worktrees/TASK-002'));

for (const dir of cleanups) {
  await rm(dir, { recursive: true, force: true });
}

console.log('Agent Board script tests passed.');
