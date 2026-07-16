# Agent Board

Use Agent Board when asked to continue project work in this repository.

## Workflow

1. List `.agent-board/tasks/` and read `.agent-board/project.json` for project overview, rules, validation commands, design rules, glossary, and inferred repo context.
2. Pick the highest-priority task with status `ready-for-agent` assigned to `claude` or `unassigned`.
3. Claim it with `node .agent-board/scripts/claim-next-task.mjs claude` (or `claim-task.mjs TASK-ID claude`). The script creates a git worktree at `.agent-board/worktrees/TASK-ID` on a task branch and prints the task file path and worktree path.
4. Do ALL code work inside that worktree. Task-state files live only in the MAIN checkout's `.agent-board/`; the scripts resolve the main checkout automatically. Never edit `.agent-board` files inside a worktree.
5. Build according to the project context, task description, acceptance criteria, constraints, and QA checklist.
6. Update `relevantFiles`, `agentNotes`, and append concise `activityLog` entries in the main checkout's task file as work progresses.
7. Commit your work on the task branch inside the worktree.
8. Run `node .agent-board/scripts/run-validation.mjs TASK-ID` — it runs the validation commands in the worktree and records evidence. `complete-task` refuses without a passing validation run.
9. Move the task to QA with `node .agent-board/scripts/complete-task.mjs TASK-ID`.
10. If acting as QA agent, claim ready QA work with `node .agent-board/scripts/start-qa.mjs TASK-ID claude`, check acceptance criteria, QA checklist, design QA checklist, and changed files in the worktree, re-run `run-validation.mjs`, then `pass-qa.mjs TASK-ID "note"` or `fail-qa.mjs TASK-ID "reason"`.
11. Move the task to `human-review` if blocked or uncertain.

The main checkout's `.agent-board/` folder is the source of truth. Preserve unknown fields; the scripts lock tasks while writing, so prefer them over manual JSON edits.
