# Repository Agents

## Agent Board Workflow

This repository uses Agent Board as the source of truth for AI coding work. Task state lives in `.agent-board/tasks/*.json` in the MAIN checkout; do not rely on copied prompts as the durable task record.

Agents should follow this workflow:

1. List `.agent-board/tasks/` to see all tasks and read `.agent-board/project.json` for project overview, coding rules, agent rules, validation commands, design rules, glossary, and inferred stack context.
2. Find tasks with status `ready-for-agent`. Prefer tasks where `assignedAgent` is `codex` or `unassigned`.
3. Claim work with `node .agent-board/scripts/claim-next-task.mjs codex` (or `claim-task.mjs TASK-ID codex`). The script creates a git worktree at `.agent-board/worktrees/TASK-ID` on a task branch and prints the task file path and worktree path.
4. Do ALL code work inside that worktree. Task-state files live only in the MAIN checkout's `.agent-board/`; the scripts resolve the main checkout automatically, so run them from anywhere. Never edit `.agent-board` files inside a worktree.
5. Read the task JSON printed by the claim script. Implement only that task.
6. Update `agentNotes`, `relevantFiles`, and append clear entries to `activityLog` in the main checkout's task file as work progresses.
7. Commit your work on the task branch inside the worktree.
8. Run `node .agent-board/scripts/run-validation.mjs TASK-ID`. This runs the task or project validation commands in the worktree and records evidence on the task. It is required: `complete-task` refuses without a passing validation run.
9. Move the task to QA with `node .agent-board/scripts/complete-task.mjs TASK-ID`.
10. QA agents claim ready QA work with `node .agent-board/scripts/start-qa.mjs TASK-ID codex` (or `claude`), review acceptance criteria and changed files in the worktree, re-run `run-validation.mjs`, then `pass-qa.mjs TASK-ID "note"` or `fail-qa.mjs TASK-ID "specific failure reason"`. Passing QA requires the task to be `qa-running`, non-empty `qaEvidence`, and a passing validation run.
11. If blocked, add a blocker note, append an activity entry, and set `status` to `human-review`.

Preserve unknown fields in Agent Board JSON files. The scripts take a per-task lock; if you edit task JSON manually, reread the file first and avoid overwriting newer updates from another agent or the VS Code extension.
