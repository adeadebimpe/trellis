# Repository Agents

## Agent Board Workflow

This repository uses Trellis as the source of truth for AI coding work. Task state lives in `.agent-board/tasks/*.json` in the MAIN checkout; do not rely on copied prompts as the durable task record.

Agents should follow this workflow:

1. List `.agent-board/tasks/` to see all tasks and read `.agent-board/project.json` for project overview, coding rules, agent rules, validation commands, design rules, glossary, and inferred stack context.
2. Find tasks with status `ready-for-agent`. Prefer tasks where `assignedAgent` is `codex` or `unassigned`.
3. Claim work with `node .agent-board/scripts/claim-next-task.mjs codex chat` (or `claim-task.mjs TASK-ID codex chat`). The `chat` surface prevents Trellis from also launching a terminal for the task. If another run owns it, do not duplicate the work; report the existing phase, agent, and surface.
4. Do ALL code work in the printed worktree path. In `direct-on-main` mode this is the main checkout and only one build may run at once. Task state always lives in the MAIN checkout's `.agent-board/`.
5. Read the task JSON printed by the claim script. Implement only that task.
6. Update `agentNotes`, `relevantFiles`, and append clear entries to `activityLog` in the main checkout's task file as work progresses.
7. Commit your work in the selected workspace. In branch-per-task mode, commit on the task branch; in direct-on-main mode, commit on the current project branch.
8. Run `node .agent-board/scripts/run-validation.mjs TASK-ID`. This runs the task or project validation commands in the worktree and records evidence on the task. It is required: `complete-task` refuses without a passing validation run.
9. Move the task to QA with `node .agent-board/scripts/complete-task.mjs TASK-ID`.
10. If the build was claimed in chat, continue QA in chat with `node .agent-board/scripts/start-qa.mjs TASK-ID codex chat`; never start a duplicate terminal. Review acceptance criteria and changed files, re-run `run-validation.mjs`, then `pass-qa.mjs TASK-ID "note"` or `fail-qa.mjs TASK-ID "specific failure reason"`.
11. If blocked, add a blocker note, append an activity entry, and set `status` to `human-review`.

Preserve unknown fields in Trellis JSON files. The scripts take a per-task lock; if you edit task JSON manually, reread the file first and avoid overwriting newer updates from another agent or the VS Code extension.
