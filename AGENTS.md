# Repository Agents

## Agent Board Workflow

This repository uses Agent Board as the source of truth for AI coding work. The visual board is backed by files in `.agent-board/`; do not rely on copied prompts as the durable task record.

Agents should follow this workflow:

1. Check `.agent-board/board.json` before starting work.
2. Read `.agent-board/project.json` for project overview, coding rules, agent rules, validation commands, design rules, glossary, and inferred stack context.
3. Find tasks with status `ready-for-agent`.
4. Prefer tasks where `assignedAgent` is `codex` or `unassigned`.
5. Claim a task with `node .agent-board/scripts/claim-next-task.mjs codex`, or manually update the task JSON with:
   - `status: "building"`
   - `claimedBy`: your agent name
   - `branchName`: a task branch such as `agent-board/TASK-001-short-title`
   - `lastUpdated`: current ISO timestamp
6. Work on the task branch when Git is available. The claim script creates and checks out the branch automatically.
7. Read the matching `.agent-board/tasks/TASK-ID.json`.
8. Implement only that task.
9. Update `agentNotes`, `relevantFiles`, and append clear entries to `activityLog` as work progresses.
10. Run relevant tests, lint, typecheck, or build commands from the task and project context.
11. Move the task to `ready-for-qa` when implementation and validation are complete.
12. QA agents should claim ready QA work with `node .agent-board/scripts/start-qa.mjs TASK-ID codex` or `claude`, run functional and design QA, then pass or fail the task.
13. If blocked, add a blocker note, append an activity entry, and set `status` to `human-review`.

Preserve unknown fields in Agent Board JSON files. Before writing, reread the task file and avoid overwriting newer updates from another agent or the VS Code extension.