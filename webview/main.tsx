import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type TaskStatus = 'backlog' | 'ready-for-agent' | 'building' | 'ready-for-qa' | 'qa-running' | 'failed-qa' | 'human-review' | 'done';
type AssignedAgent = 'claude' | 'codex' | 'unassigned';
type Priority = 'high' | 'medium' | 'low';

interface ActivityEntry {
  timestamp: string;
  actor: string;
  message: string;
}

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  assignedAgent: AssignedAgent;
  qaAgent: AssignedAgent;
  brief: string;
  description: string;
  acceptanceCriteria: string[];
  qaChecklist: string[];
  designQaChecklist: string[];
  validationCommands: string[];
  relevantFiles: string[];
  constraints: string[];
  agentNotes: string;
  qaNotes: ActivityEntry[];
  qaEvidence: string[];
  activityLog: ActivityEntry[];
  claimedBy: string;
  qaClaimedBy: string;
  branchName: string;
  worktreePath: string;
  claimedAt: string;
  lastValidation: {
    ranAt: string;
    passed: boolean;
    results: Array<{ command: string; exitCode: number; durationMs: number; outputTail: string }>;
  } | null;
  shipResult: {
    mode: 'pr' | 'local-merge';
    branch: string;
    shippedAt: string;
    prUrl?: string;
    mergedInto?: string;
    mergeCommit?: string;
  } | null;
  lastUpdated: string;
}

interface ProjectContext {
  version: 1;
  contextNotes: string;
  overview: string;
  goals: string[];
  architectureNotes: string;
  codingRules: string[];
  agentRules: string[];
  validationCommands: string[];
  designRules: string[];
  glossary: string[];
  inference: {
    packageManager: string;
    scripts: string[];
    detectedFiles: string[];
    likelyStack: string[];
    suggestedValidation: string[];
    lastInferred: string;
  };
  lastUpdated: string;
}

interface BoardState {
  board: {
    columns: Array<{ id: TaskStatus; title: string }>;
  };
  tasks: Task[];
  project: ProjectContext;
  liveTerminals: string[];
  settings: {
    specProvider?: string;
    specProviderLabel: string;
    setupComplete: boolean;
  };
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

const statusHints: Record<TaskStatus, string> = {
  backlog: 'Idea intake',
  'ready-for-agent': 'Claimable work',
  building: 'Agent active',
  'ready-for-qa': 'Validation queue',
  'qa-running': 'QA agent active',
  'failed-qa': 'Needs repair',
  'human-review': 'Needs judgment',
  done: 'Closed loop'
};

function App(): JSX.Element {
  const [state, setState] = useState<BoardState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Task | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectContext | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectFieldsOpen, setProjectFieldsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [projectSaveState, setProjectSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const selected = state?.tasks.find((task) => task.id === selectedId) ?? null;

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data.type === 'state') {
        setState(event.data.state);
        if (selectedId) {
          const fresh = event.data.state.tasks.find((task: Task) => task.id === selectedId);
          setDraft(fresh ? cloneTask(fresh) : null);
        }
        if (projectOpen) {
          setProjectDraft(cloneProject(event.data.state.project));
        }
      }
      if (event.data.type === 'saved') {
        setSaveState('saved');
        window.setTimeout(() => setSaveState('idle'), 1400);
      }
      if (event.data.type === 'error') {
        setSaveState('error');
        setProjectSaveState('error');
      }
      if (event.data.type === 'saved-project') {
        setProjectSaveState('saved');
        window.setTimeout(() => setProjectSaveState('idle'), 1400);
      }
      if (event.data.type === 'select-task') {
        setSelectedId(event.data.id);
      }
      if (event.data.type === 'task-deleted') {
        setSelectedId(null);
        setDraft(null);
      }
      if (event.data.type === 'fresh-started') {
        setSelectedId(null);
        setDraft(null);
        setProjectDraft(null);
        setProjectOpen(false);
      }
    };
    window.addEventListener('message', listener);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, [selectedId, projectOpen]);

  useEffect(() => {
    setDraft(selected ? cloneTask(selected) : null);
  }, [selected]);

  useEffect(() => {
    setConfirmDelete(false);
  }, [selectedId]);

  const sendAction = (task: Task, action: string) => {
    vscode.postMessage({ type: 'action', id: task.id, task, action, expectedLastUpdated: task.lastUpdated });
  };

  const moveTask = (id: string, status: TaskStatus) => {
    const task = state?.tasks.find((item) => item.id === id);
    vscode.postMessage({ type: 'move-task', id, status, expectedLastUpdated: task?.lastUpdated });
  };

  if (state && !state.settings.setupComplete) {
    return (
      <main className="shell">
        <section className="setupScreen" aria-label="Agent Board setup">
          <div className="setupPanel">
            <p className="eyebrow">First run setup</p>
            <h1>Connect Agent Board</h1>
            <p>
              Sign in once with the agent CLI you want to use for PRD generation and task execution. Codex and Claude keep their own credentials, so you do not need to sign in again on every refresh.
            </p>
            <div className="setupActions">
              <button className="primary" onClick={() => vscode.postMessage({ type: 'sign-in-codex' })}>Sign in to Codex</button>
              <button className="primary" onClick={() => vscode.postMessage({ type: 'sign-in-claude' })}>Sign in to Claude</button>
              <button className="ghost" onClick={() => vscode.postMessage({ type: 'continue-to-board' })}>Continue to board</button>
            </div>
            <p className="setupStatus">PRD generator: {state.settings.specProviderLabel}</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Agent Board</h1>
        </div>
        <div className="telemetry">
          <div className="menuWrap">
            <button className="ghost moreButton" aria-label="More actions" title="More actions" onClick={() => setMenuOpen((open) => !open)}>⋯</button>
            {menuOpen && (
              <>
                <div className="menuOverlay" onClick={() => setMenuOpen(false)} />
                <div className="menu" role="menu">
                  <p className="menuStatus">PRD: {state?.settings.specProviderLabel ?? 'Not configured'}</p>
                  <button role="menuitem" onClick={() => {
                    setMenuOpen(false);
                    if (state?.project) {
                      setProjectDraft(cloneProject(state.project));
                      setProjectOpen(true);
                    }
                  }}>Project context</button>
                  <button role="menuitem" onClick={() => {
                    setMenuOpen(false);
                    vscode.postMessage({ type: 'sign-in-agents' });
                  }}>Agent sign in</button>
                  <button role="menuitem" className="expandButton" onClick={() => {
                    setMenuOpen(false);
                    vscode.postMessage({ type: 'open-full-board' });
                  }}>Open full board</button>
                  <button role="menuitem" onClick={() => {
                    setMenuOpen(false);
                    vscode.postMessage({ type: 'fresh-start' });
                  }}>Fresh start</button>
                </div>
              </>
            )}
          </div>
          <button className="primary" onClick={() => vscode.postMessage({ type: 'create-task' })}>New task</button>
        </div>
      </header>

      <section className="board" aria-label="Agent Board columns">
        {state?.board.columns.map((column) => {
          const tasks = state.tasks.filter((task) => task.status === column.id);
          return (
            <div
              className="lane"
              key={column.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (dragId) moveTask(dragId, column.id);
                setDragId(null);
              }}
            >
              <div className="laneHeader">
                <div>
                  <h2>{column.title}</h2>
                  <p>{statusHints[column.id]}</p>
                </div>
                <span>{tasks.length}</span>
              </div>
              <div className="cards">
                {tasks.map((task) => (
                  <button
                    className={`card priority-${task.priority}`}
                    draggable
                    key={task.id}
                    onClick={() => setSelectedId(task.id)}
                    onDragStart={() => setDragId(task.id)}
                    onDragEnd={() => setDragId(null)}
                  >
                    <span className="cardMeta">
                      <strong>{task.id}</strong>
                      <em>{task.priority}</em>
                    </span>
                    <span className="cardTitle">{task.title || 'Untitled task'}</span>
                    <span className="agentLine">
                      <span>{task.assignedAgent}</span>
                      <span>{task.status === 'qa-running' ? task.qaClaimedBy || 'qa' : task.claimedBy || 'unclaimed'}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </section>

      {draft && (
        <aside className="drawer" aria-label="Task drawer">
          <div className="drawerHeader">
            <div>
              <p className="eyebrow">{draft.id} · {draft.status}</p>
              <input className="titleInput" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </div>
            <button className="ghost" onClick={() => setSelectedId(null)}>Close</button>
          </div>

          <div className="quickControls">
            <label>
              <span>Assigned Agent</span>
              <select
                value={draft.assignedAgent}
                onChange={(event) => {
                  const assignedAgent = event.target.value as AssignedAgent;
                  const next = { ...draft, assignedAgent };
                  setDraft(next);
                  vscode.postMessage({ type: 'save-task', task: next, expectedLastUpdated: selected?.lastUpdated });
                }}
              >
                <option value="unassigned">unassigned</option>
                <option value="claude">claude</option>
                <option value="codex">codex</option>
              </select>
            </label>
            <label>
              <span>QA Agent</span>
              <select
                value={draft.qaAgent}
                onChange={(event) => {
                  const qaAgent = event.target.value as AssignedAgent;
                  const next = { ...draft, qaAgent };
                  setDraft(next);
                  vscode.postMessage({ type: 'save-task', task: next, expectedLastUpdated: selected?.lastUpdated });
                }}
              >
                <option value="unassigned">unassigned</option>
                <option value="claude">claude</option>
                <option value="codex">codex</option>
              </select>
            </label>
            <label>
              <span>Status</span>
              <select
                value={draft.status}
                onChange={(event) => {
                  const status = event.target.value as TaskStatus;
                  const next = { ...draft, status };
                  setDraft(next);
                  vscode.postMessage({ type: 'move-task', id: draft.id, status, expectedLastUpdated: selected?.lastUpdated });
                }}
              >
                <option value="backlog">backlog</option>
                <option value="ready-for-agent">ready-for-agent</option>
                <option value="building">building</option>
                <option value="ready-for-qa">ready-for-qa</option>
                <option value="qa-running">qa-running</option>
                <option value="failed-qa">failed-qa</option>
                <option value="human-review">human-review</option>
                <option value="done">done</option>
              </select>
            </label>
          </div>

          <div className="actions">
            <Action
              label="Generate PRD"
              onClick={() => sendAction(draft, 'generate-spec')}
              primary
              disabled={!draft.brief.trim()}
              title={!draft.brief.trim() ? 'Write or paste the task idea in the Brief field first.' : undefined}
            />
            <Action
              label="Ready for agent"
              onClick={() => sendAction(draft, 'mark-ready')}
              disabled={draft.status === 'ready-for-agent'}
              title={draft.status === 'ready-for-agent' ? 'Already ready for agent.' : undefined}
            />
            <Action
              label="Start build"
              onClick={() => sendAction(draft, 'start-build')}
              disabled={!(draft.status === 'ready-for-agent' || draft.status === 'building') || draft.assignedAgent === 'unassigned'}
              title={draft.assignedAgent === 'unassigned'
                ? 'Assign Claude or Codex first.'
                : !(draft.status === 'ready-for-agent' || draft.status === 'building')
                  ? 'Move the task to Ready for Agent first.'
                  : undefined}
            />
            {draft.status === 'building' && (
              <p className="automationHint">
                {(draft.qaNotes ?? []).length
                  ? 'The build agent is repairing the latest QA feedback. QA will run again automatically.'
                  : 'QA starts automatically after the build agent validates and completes this task.'}
              </p>
            )}
            {draft.status === 'ready-for-qa' && (
              <Action label="QA is starting automatically…" onClick={() => undefined} disabled />
            )}
            {draft.status === 'failed-qa' && (
              <Action label="Returning to build for repair…" onClick={() => undefined} disabled />
            )}
            {draft.status === 'qa-running' && (
              <p className="automationHint">QA is running and will record pass or fail automatically.</p>
            )}
            {state?.liveTerminals?.includes(draft.id) && (
              <Action label="Show agent terminal" onClick={() => vscode.postMessage({ type: 'show-terminal', id: draft.id })} />
            )}
            {draft.status === 'human-review' && (
              <Action label="Ship (PR / merge)" onClick={() => vscode.postMessage({ type: 'ship-task', id: draft.id, expectedLastUpdated: selected?.lastUpdated })} primary />
            )}
            {draft.status === 'human-review' && (
              <Action label="Mark done" onClick={() => sendAction(draft, 'mark-done')} />
            )}
            {draft.status === 'done' && (
              <Action label="Archive task" onClick={() => vscode.postMessage({ type: 'archive-task', id: draft.id })} />
            )}
          </div>

          {(draft.lastValidation || draft.shipResult) && (
            <div className="statusPanel">
              {draft.lastValidation && (
                <p className={draft.lastValidation.passed ? 'statusOk' : 'statusBad'}>
                  Validation {draft.lastValidation.passed ? 'passed' : 'failed'} · {draft.lastValidation.results.length} command(s) · {new Date(draft.lastValidation.ranAt).toLocaleString()}
                </p>
              )}
              {draft.shipResult && (
                <p className="statusOk">
                  {draft.shipResult.mode === 'pr' ? (
                    <>Pull request: <a href={draft.shipResult.prUrl}>{draft.shipResult.prUrl}</a></>
                  ) : (
                    <>Merged into {draft.shipResult.mergedInto} ({(draft.shipResult.mergeCommit ?? '').slice(0, 8)})</>
                  )}
                </p>
              )}
            </div>
          )}

          <div className="formGrid">
            <Field
              label="Brief"
              placeholder="Write or paste the rough idea and any context. Generate PRD turns this into the structured spec below."
              value={draft.brief}
              onChange={(value) => setDraft({ ...draft, brief: value })}
            />
            <Field label="Generated PRD Description" value={draft.description} onChange={(value) => setDraft({ ...draft, description: value })} />
            <ListField label="Acceptance Criteria" value={draft.acceptanceCriteria} onChange={(value) => setDraft({ ...draft, acceptanceCriteria: splitLines(value) })} />
            <ListField label="QA Checklist" value={draft.qaChecklist} onChange={(value) => setDraft({ ...draft, qaChecklist: splitLines(value) })} />
            <ListField label="Design QA Checklist" value={draft.designQaChecklist} onChange={(value) => setDraft({ ...draft, designQaChecklist: splitLines(value) })} />
            <ListField label="Validation Commands" value={draft.validationCommands} onChange={(value) => setDraft({ ...draft, validationCommands: splitLines(value) })} />
            <ListField label="Relevant Files" value={draft.relevantFiles} onChange={(value) => setDraft({ ...draft, relevantFiles: splitLines(value) })} />
            <ListField label="Constraints" value={draft.constraints} onChange={(value) => setDraft({ ...draft, constraints: splitLines(value) })} />
            <Field label="Agent Notes" value={draft.agentNotes} onChange={(value) => setDraft({ ...draft, agentNotes: value })} />
            <ListField label="QA Evidence" value={draft.qaEvidence} onChange={(value) => setDraft({ ...draft, qaEvidence: splitLines(value) })} />
            <label>
              <span>Priority</span>
              <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as Priority })}>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </label>
            <label>
              <span>Branch Name</span>
              <input className="textInput" value={draft.branchName} onChange={(event) => setDraft({ ...draft, branchName: event.target.value })} />
            </label>
          </div>

          <div className="drawerFooter">
            <button
              className="primary"
              disabled={saveState === 'saving'}
              onClick={() => {
                setSaveState('saving');
                vscode.postMessage({ type: 'save-task', task: draft, expectedLastUpdated: selected?.lastUpdated });
              }}
            >
              {saveState === 'saving' ? 'Saving...' : 'Save Task'}
            </button>
            <button
              className="danger"
              title={confirmDelete ? 'Click again to permanently delete this task.' : undefined}
              onClick={() => {
                // window.confirm is blocked inside VS Code webviews, so confirm in-place.
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  window.setTimeout(() => setConfirmDelete(false), 4000);
                  return;
                }
                vscode.postMessage({ type: 'delete-task', id: draft.id });
              }}
            >
              {confirmDelete ? 'Confirm delete?' : 'Delete Task'}
            </button>
            <p>
              {saveState === 'saved' && 'Saved. '}
              {saveState === 'error' && 'Save failed. '}
              Last updated {new Date(draft.lastUpdated).toLocaleString()}
            </p>
          </div>

          <section className="activity">
            <h3>Activity Log</h3>
            {(draft.activityLog ?? []).slice().reverse().map((entry, index) => (
              <article key={`${entry.timestamp}-${index}`}>
                <time>{new Date(entry.timestamp).toLocaleString()}</time>
                <strong>{entry.actor}</strong>
                <p>{entry.message}</p>
              </article>
            ))}
          </section>
          <section className="activity">
            <h3>QA Notes</h3>
            {(draft.qaNotes ?? []).slice().reverse().map((entry, index) => (
              <article key={`${entry.timestamp}-qa-${index}`}>
                <time>{new Date(entry.timestamp).toLocaleString()}</time>
                <strong>{entry.actor}</strong>
                <p>{entry.message}</p>
              </article>
            ))}
          </section>
        </aside>
      )}

      {projectDraft && (
        <aside className="drawer projectDrawer" aria-label="Project context drawer">
          <div className="drawerHeader">
            <div>
              <p className="eyebrow">Shared agent context</p>
              <h2 className="drawerTitle">Project Context</h2>
            </div>
            <button className="ghost" onClick={() => {
              setProjectDraft(null);
              setProjectOpen(false);
            }}>Close</button>
          </div>

          <div className="contextBlock">
            <Field
              label="Project context"
              big
              placeholder="Paste anything agents should know before building: product overview, architecture notes, conventions, constraints, links. This goes to PRD generation and is stored in .agent-board/project.json for agents."
              value={projectDraft.contextNotes ?? ''}
              onChange={(value) => setProjectDraft({ ...projectDraft, contextNotes: value })}
            />
          </div>

          <div className="contextActions">
            <button
              className="primary"
              disabled={projectSaveState === 'saving'}
              onClick={() => {
                setProjectSaveState('saving');
                vscode.postMessage({ type: 'infer-project' });
              }}
            >
              Infer from repo
            </button>
            <button
              className="primary"
              disabled={projectSaveState === 'saving'}
              onClick={() => {
                setProjectSaveState('saving');
                vscode.postMessage({ type: 'save-project', project: projectDraft });
              }}
            >
              {projectSaveState === 'saving' ? 'Saving...' : 'Save context'}
            </button>
            <p>
              {projectSaveState === 'saved' && 'Saved. '}
              {projectSaveState === 'error' && 'Save failed. '}
              Last updated {new Date(projectDraft.lastUpdated).toLocaleString()}
            </p>
          </div>

          <div className="contextBlock">
            <ListField label="Validation Commands (used by QA runs, one per line)" value={projectDraft.validationCommands} onChange={(value) => setProjectDraft({ ...projectDraft, validationCommands: splitLines(value) })} />
          </div>

          <button className="sectionToggle" onClick={() => setProjectFieldsOpen((open) => !open)}>
            {projectFieldsOpen ? '▾' : '▸'} Structured fields (optional)
          </button>
          {projectFieldsOpen && (
            <div className="formGrid">
              <Field label="Project Overview" value={projectDraft.overview} onChange={(value) => setProjectDraft({ ...projectDraft, overview: value })} />
              <ListField label="Project Goals" value={projectDraft.goals} onChange={(value) => setProjectDraft({ ...projectDraft, goals: splitLines(value) })} />
              <Field label="Architecture Notes" value={projectDraft.architectureNotes} onChange={(value) => setProjectDraft({ ...projectDraft, architectureNotes: value })} />
              <ListField label="Coding Rules" value={projectDraft.codingRules} onChange={(value) => setProjectDraft({ ...projectDraft, codingRules: splitLines(value) })} />
              <ListField label="Agent Rules" value={projectDraft.agentRules} onChange={(value) => setProjectDraft({ ...projectDraft, agentRules: splitLines(value) })} />
              <ListField label="Design Rules" value={projectDraft.designRules} onChange={(value) => setProjectDraft({ ...projectDraft, designRules: splitLines(value) })} />
              <ListField label="Glossary" value={projectDraft.glossary} onChange={(value) => setProjectDraft({ ...projectDraft, glossary: splitLines(value) })} />
            </div>
          )}

          <section className="inferencePanel">
            <h3>Inference</h3>
            <InfoLine label="Package manager" value={projectDraft.inference.packageManager || 'unknown'} />
            <InfoLine label="Likely stack" value={projectDraft.inference.likelyStack.join(', ') || 'none yet'} />
            <InfoLine label="Scripts" value={projectDraft.inference.scripts.join(', ') || 'none detected'} />
            <InfoLine label="Detected files" value={projectDraft.inference.detectedFiles.join(', ') || 'none detected'} />
            <InfoLine label="Suggested validation" value={projectDraft.inference.suggestedValidation.join(', ') || 'none detected'} />
          </section>
        </aside>
      )}
    </main>
  );
}

function Action({ label, onClick, primary = false, disabled = false, title }: { label: string; onClick: () => void; primary?: boolean; disabled?: boolean; title?: string }): JSX.Element {
  return <button className={`action ${primary ? 'actionPrimary' : ''}`} disabled={disabled} title={title} onClick={onClick}>{label}</button>;
}

function Field({ label, value, onChange, placeholder, big = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; big?: boolean }): JSX.Element {
  return <label><span>{label}</span><textarea className={big ? 'bigInput' : undefined} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function ListField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string) => void }): JSX.Element {
  return <Field label={label} value={(value ?? []).join('\n')} onChange={onChange} />;
}

function InfoLine({ label, value }: { label: string; value: string }): JSX.Element {
  return <p><strong>{label}</strong><span>{value}</span></p>;
}

function splitLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function cloneTask(task: Task): Task {
  return JSON.parse(JSON.stringify(task)) as Task;
}

function cloneProject(project: ProjectContext): ProjectContext {
  return JSON.parse(JSON.stringify(project)) as ProjectContext;
}

createRoot(document.getElementById('root')!).render(<App />);
