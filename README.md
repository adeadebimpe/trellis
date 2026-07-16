# Agent Board

Agent Board is a VS Code extension that turns `.agent-board/` into a repo-native source of truth for AI coding agents.

Use `Agent Board: Prepare Agent Files` to create the task store, `AGENTS.md`, Claude Code skill, and helper scripts. Use `Agent Board: Open Board` to manage tasks in the visual Kanban board.

## AI Setup

`Generate PRD` uses the configured generation agent: Codex CLI, Claude Code, or OpenAI API.

It uses the selected task plus `.agent-board/project.json` to populate the task description, acceptance criteria, QA checklist, design QA checklist, validation commands, and constraints.

## Agent CLI Sign-In

Run `Agent Board: Sign In to Agent CLI` to open the official Codex or Claude Code sign-in flow in a VS Code terminal.

Agent Board does not capture or store Codex or Claude OAuth tokens. The official CLIs keep their own credentials; Agent Board only helps launch their supported login commands.
