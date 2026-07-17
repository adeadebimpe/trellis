# Agent Board

Use Agent Board when asked to continue project work in this repository.

## Workflow

1. Inspect `.agent-board/board.json`.
2. Read `.agent-board/project.json` for project overview, rules, validation commands, design rules, glossary, and inferred repo context.
3. Pick the highest-priority task with status `ready-for-agent` assigned to `claude` or `unassigned`.
4. Claim the task with `node .agent-board/scripts/claim-next-task.mjs claude`, or manually set:
   - `status: "building"`
   - `claimedBy: "claude"`
   - `branchName`: a task branch such as `agent-board/TASK-001-short-title`
   - `lastUpdated`: current ISO timestamp
5. Work on the task branch when Git is available. The claim script creates and checks out the branch automatically.
6. Read the task JSON in `.agent-board/tasks/`.
7. Build according to the project context, task description, acceptance criteria, constraints, and QA checklist.
8. Update the task file as work progresses.
9. Add changed files to `relevantFiles`.
10. Add clear implementation notes to `agentNotes`.
11. Append concise activity entries for major decisions and validation results.
12. Run relevant validation commands such as tests, lint, typecheck, or build.
13. Move the task to `ready-for-qa` when complete.
14. If acting as QA agent, claim ready QA work with `node .agent-board/scripts/start-qa.mjs TASK-ID claude`, check acceptance criteria, QA checklist, design QA checklist, changed files, and validation evidence.
15. Move the task to `human-review` if blocked or uncertain.
16. After completing a task, run `node .agent-board/scripts/claim-next-task.mjs claude`. Continue from the returned task worktree and repeat until the script prints `{"noTask":true}`.

The `.agent-board/` folder is the source of truth. Preserve unknown fields and reread files before editing so other agent updates are not lost.
