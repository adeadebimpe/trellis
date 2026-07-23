# Agent profiles and automatic routing

## Recommendation

Agent Board should support named **agent profiles**, but a profile should not be a new executable agent type.

Today, `assignedAgent` and `qaAgent` identify a runtime provider: `codex`, `claude`, or `unassigned`. A “Design agent” is a different concept: it is a role with a prompt, capabilities, and routing rules that can run on either Codex or Claude. Keeping role and runtime separate avoids hard-coding every future specialty into task status, TypeScript unions, scripts, and CLI detection.

The model should be:

```text
Task phase -> agent profile -> available runtime -> terminal execution
```

For example:

```text
specification -> product-spec -> Claude
implementation -> frontend-build -> Codex
quality -> design-review -> Claude
quality -> code-qa -> Codex
```

## Proposed data model

Add profiles to `.trellis/project.json`, because they are project-level operating policy:

```json
{
  "agentProfiles": [
    {
      "id": "frontend-build",
      "name": "Frontend builder",
      "role": "implementation",
      "runtime": "auto",
      "capabilities": ["frontend", "accessibility", "interaction-design"],
      "instructions": "Follow the existing design system and verify narrow sidebar layouts.",
      "enabled": true
    },
    {
      "id": "design-review",
      "name": "Design reviewer",
      "role": "quality",
      "runtime": "claude",
      "capabilities": ["visual-design", "accessibility", "responsive-ui"],
      "instructions": "Review visual hierarchy, theme compatibility, and interaction states.",
      "enabled": true
    }
  ]
}
```

Suggested profile fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable project-local identifier used by tasks and logs. |
| `name` | Human-readable label. |
| `role` | One of `specification`, `implementation`, or `quality` for the first version. |
| `runtime` | `codex`, `claude`, or `auto`; this remains separate from the role. |
| `capabilities` | Routing vocabulary such as `frontend`, `backend`, `docs`, `design`, or `accessibility`. |
| `instructions` | Extra prompt content scoped to this profile. |
| `enabled` | Allows temporary removal from routing without deleting history. |

Tasks should gain optional profile references while retaining the existing runtime fields:

```json
{
  "assignedProfile": "frontend-build",
  "qaProfiles": ["code-qa", "design-review"],
  "routing": {
    "mode": "auto",
    "reason": "Task changes React webview layout and includes a design QA checklist."
  }
}
```

`assignedAgent` and `qaAgent` remain supported during migration and continue to record the resolved runtime. Existing repositories and scripts therefore keep working.

## Routing behavior

Automatic assignment should be explainable and deterministic before it becomes AI-assisted.

1. Derive required capabilities from structured task data:
   - `designQaChecklist` or design rules -> `design` and `accessibility`
   - files under `webview/` -> `frontend`
   - validation or test-only work -> `qa`
   - docs-only relevant files -> `docs`
2. Filter to enabled profiles with the required role.
3. Score capability overlap.
4. Prefer a profile whose runtime is installed and authenticated.
5. Resolve ties by project profile order.
6. Store the selected profile and a short routing reason on the task.

An AI-generated PRD may suggest capabilities, but it should not silently choose a profile. The deterministic router should make the final selection from project-owned profiles. This prevents prompt wording from unexpectedly changing who receives work.

Manual assignment always wins. A task with `routing.mode: "manual"` should never be reassigned during PRD regeneration or refresh.

## Multiple QA profiles

Implementation has one owner at a time. Quality can be a sequence of checks.

The first release should run QA profiles serially, not concurrently:

```text
build -> code QA -> design QA (when required) -> Human Review
```

Serial QA avoids two agents editing the same task record or worktree simultaneously. Each QA profile appends its evidence and result. Any failure returns the task to the implementation profile with all findings. After repair, the QA sequence restarts so earlier assumptions are revalidated.

The task can store lightweight progress without adding board columns:

```json
{
  "qaRun": {
    "profiles": ["code-qa", "design-review"],
    "currentIndex": 1,
    "results": [
      { "profile": "code-qa", "status": "passed" }
    ]
  }
}
```

The board should continue to show `QA Running`; the card or drawer can show `Design review · 2 of 2`. Creating a column for every specialty would make the sidebar unusable and couple workflow state to project configuration.

## UI direction

### Project context: Agents

Add an **Agents** section beside project context. It contains compact profile rows with:

- profile name and role;
- runtime selector (`Auto`, `Codex`, `Claude`);
- capability chips;
- enabled toggle;
- expandable instructions;
- an “Add profile” action.

Ship three optional templates: Builder, Code QA, and Design Review. Templates create editable project data; they are not permanent built-ins.

### Task drawer

Replace raw runtime-first assignment with:

- `Build profile`: Auto / named implementation profiles;
- `QA route`: Auto / selected quality profiles;
- a small routing explanation such as “Frontend builder · matched frontend + accessibility”.

The resolved runtime remains visible as secondary information. If the required runtime is unavailable, show a blocking inline message and allow another profile/runtime to be chosen.

### Activity

Every routing decision should be recorded:

```text
Auto-assigned Frontend builder (Codex): matched frontend, accessibility.
Design review failed: focus state is not visible in High Contrast.
Returned to Frontend builder with 1 QA finding.
```

This makes autonomous routing auditable and gives Human Review enough context to override it.

## Prompt composition

Prompts should be composed from independent layers:

1. invariant Agent Board workflow and safety instructions;
2. project context and rules;
3. profile instructions;
4. task specification and latest feedback;
5. phase-specific completion contract.

Profile instructions must not replace workflow rules. A profile cannot weaken worktree isolation, validation requirements, task locking, or Human Review behavior.

## Failure and safety rules

- Never launch two profiles that can write in the same worktree concurrently.
- If no matching enabled profile exists, leave the task ready and explain what is missing.
- If a selected runtime is unavailable, try another runtime only when the profile runtime is `auto`.
- Cap automatic build/QA repair cycles (recommended default: three). Exceeding the cap moves the task to Human Review with the accumulated evidence.
- Deleting a profile must not invalidate task history; tasks retain the profile id and a snapshot name in activity entries.
- Profile instructions are project code and should be reviewable in `.trellis/project.json`.

## Delivery plan

### Phase 1: profiles and manual selection

- Add the project schema and normalization for agent profiles.
- Add profile management in Project Context.
- Add task profile selectors.
- Resolve a profile to the existing Codex/Claude launch path.
- Preserve `assignedAgent` and `qaAgent` compatibility.

This proves the role/runtime separation without changing automation policy.

### Phase 2: deterministic auto-routing

- Add capability inference from task fields and relevant files.
- Store routing mode and explanation.
- Auto-select implementation and QA profiles after PRD generation.
- Add routing activity entries and unavailable-runtime feedback.

### Phase 3: sequential specialist QA

- Add ordered `qaProfiles` and `qaRun` progress.
- Compose profile-specific QA prompts.
- Restart the QA sequence after automatic repair.
- Add an automatic-cycle limit and Human Review escalation.

## Explicit non-goals for the first release

- Arbitrary user-authored shell commands per profile.
- Concurrent agents editing one worktree.
- A board column per agent role.
- Global profiles shared invisibly across repositories.
- Letting an LLM silently invent or persist new profiles.

## Decision

Proceed with agent profiles, beginning with manual project-local profiles and runtime resolution. Do not extend `AssignedAgent` with values such as `design` or `qa`; those are roles, not executable providers. Add deterministic auto-routing only after profile selection and audit history are working.
