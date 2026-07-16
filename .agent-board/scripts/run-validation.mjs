#!/usr/bin/env node
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
      output += '\n[run-validation] Timed out after ' + COMMAND_TIMEOUT_MS / 1000 + 's.';
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
