# Trellis

Structure autonomous coding work from task to verified code.

Trellis is a repo-native Kanban command centre for coordinating Codex and Claude Code inside VS Code. It keeps project context, task state, validation evidence, human feedback, and QA history close to the code so people and coding agents work from the same durable record.

## What Trellis does

- Turns a rough request into an implementation-ready task specification.
- Routes work to Codex or Claude Code and launches the supported CLI.
- Isolates implementation in a task-specific Git branch and worktree.
- Records validation evidence before work can move to QA.
- Keeps human comments and QA feedback attached to the task.
- Merges approved work locally while preserving an auditable activity history.

## Getting started

1. Open a Git repository in VS Code.
2. Run **Trellis: Prepare Agent Files** from the Command Palette.
3. Open Trellis from the Activity Bar or run **Trellis: Open Board**.
4. Add a task, generate or complete its specification, and move it to **Ready for Agent**.
5. Assign Codex or Claude Code and start the build.

Trellis creates a `.agent-board/` directory containing project context, task records, helper scripts, locks, and task worktrees. The directory name is retained for compatibility with existing repositories.

## Agent setup

Install at least one supported agent CLI and sign in through its official flow:

- [OpenAI Codex CLI](https://developers.openai.com/codex/cli/)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)

Run **Trellis: Sign In to Agent CLI** to open the selected CLI's own authentication command in a VS Code terminal. Trellis does not capture or store Codex or Claude OAuth tokens.

Trellis runs build tasks sequentially across a workspace: with automatic continuation enabled, the next ready task starts after the active build command ends. QA and isolated worktree activity may run concurrently, but duplicate runs for the same task are blocked. Use **Trellis: Show Agent Terminal Diagnostics** to list active Trellis terminals by task, agent, and phase. Diagnostics are event-driven and do not continuously sample resources; use your operating system's activity monitor for process-level CPU and memory figures.

## Spec generation

Trellis can generate task specifications with Codex CLI, Claude Code, or the OpenAI API. Generated specifications can include acceptance criteria, QA and design checks, validation commands, implementation constraints, and relevant source files.

Choose a provider with **Trellis: Configure Spec Generation**. API keys are stored with VS Code SecretStorage and are not written to the repository.

## Repository data and privacy

Task data stays in the current repository under `.agent-board/`. CLI agents run through their official local commands and follow the permissions and data policies of the provider you choose. Trellis does not operate a separate hosted service.

By default, Trellis adds `.agent-board/` to `.gitignore`. Disable **Trellis › Git-ignore Board Directory** if your team intentionally wants to commit project context and task history.

## Compatibility

The 0.1 release changes the public product name to Trellis. Existing `.agent-board/` directories, `agentBoard.*` settings, command IDs, and task records remain supported; no repository migration is required.

## Requirements

- VS Code 1.90 or newer
- Git for branch, worktree, and merge workflows
- Node.js for the generated Trellis helper scripts
- Codex CLI or Claude Code for automated implementation

## License

Copyright © 2026 Adebimpe Adebowale. Usage terms are included in the extension's `LICENSE` file.
