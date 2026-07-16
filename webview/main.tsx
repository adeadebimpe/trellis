import React, { useEffect, useMemo, useState } from 'react';
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
  lastUpdated: string;
}

interface ProjectContext {
  version: 1;
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

  const counts = useMemo(() => {
    const result = { active: 0, ready: 0, qa: 0 };
    for (const task of state?.tasks ?? []) {
      if (task.status === 'building') result.active += 1;
      if (task.status === 'ready-for-agent') result.ready += 1;
      if (task.status === 'ready-for-qa' || task.status === 'qa-running' || task.status === 'failed-qa') result.qa += 1;
    }
    return result;
  }, [state]);

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
          <Metric label="Ready" value={counts.ready} />
          <Metric label="Building" value={counts.active} />
          <Metric label="QA" value={counts.qa} />
          <Metric label="PRD" value={state?.settings.specProviderLabel ?? 'Not configured'} />
          <button className="ghost" onClick={() => {
            if (state?.project) {
              setProjectDraft(cloneProject(state.project));
              setProjectOpen(true);
            }
          }}>Project context</button>
          <button className="ghost" onClick={() => vscode.postMessage({ type: 'sign-in-agents' })}>Agent sign in</button>
          <button className="ghost expandButton" onClick={() => vscode.postMessage({ type: 'open-full-board' })}>Open full board</button>
          <button className="ghost" onClick={() => vscode.postMessage({ type: 'fresh-start' })}>Fresh start</button>
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
            <Action label="Generate PRD" onClick={() => sendAction(draft, 'generate-spec')} primary />
            <Action label="Ready for agent" onClick={() => sendAction(draft, 'mark-ready')} />
            <Action label="Start build" onClick={() => sendAction(draft, 'start-build')} />
            <Action label="Ready for QA" onClick={() => sendAction(draft, 'mark-ready-qa')} />
            <Action label="Start QA" onClick={() => sendAction(draft, 'start-qa')} />
            <Action label="Pass QA" onClick={() => sendAction(draft, 'pass-qa')} />
          </div>

          <div className="formGrid">
            <Field label="Task description" value={draft.brief} onChange={(value) => setDraft({ ...draft, brief: value })} />
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
              onClick={() => {
                setSaveState('saving');
                vscode.postMessage({ type: 'save-task', task: draft, expectedLastUpdated: selected?.lastUpdated });
              }}
            >
              {saveState === 'saving' ? 'Saving...' : 'Save Task'}
            </button>
            <button
              className="danger"
              onClick={() => {
                const confirmed = window.confirm(`Delete ${draft.id}? This removes its task JSON file.`);
                if (confirmed) {
                  vscode.postMessage({ type: 'delete-task', id: draft.id });
                }
              }}
            >
              Delete Task
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

          <div className="contextActions">
            <button
              className="primary"
              onClick={() => {
                setProjectSaveState('saving');
                vscode.postMessage({ type: 'infer-project' });
              }}
            >
              Infer from repo
            </button>
            <button
              className="primary"
              onClick={() => {
                setProjectSaveState('saving');
                vscode.postMessage({ type: 'save-project', project: projectDraft });
              }}
            >
              Save context
            </button>
            <p>
              {projectSaveState === 'saving' && 'Saving... '}
              {projectSaveState === 'saved' && 'Saved. '}
              {projectSaveState === 'error' && 'Save failed. '}
              Last updated {new Date(projectDraft.lastUpdated).toLocaleString()}
            </p>
          </div>

          <div className="formGrid">
            <Field label="Project Overview" value={projectDraft.overview} onChange={(value) => setProjectDraft({ ...projectDraft, overview: value })} />
            <ListField label="Project Goals" value={projectDraft.goals} onChange={(value) => setProjectDraft({ ...projectDraft, goals: splitLines(value) })} />
            <Field label="Architecture Notes" value={projectDraft.architectureNotes} onChange={(value) => setProjectDraft({ ...projectDraft, architectureNotes: value })} />
            <ListField label="Coding Rules" value={projectDraft.codingRules} onChange={(value) => setProjectDraft({ ...projectDraft, codingRules: splitLines(value) })} />
            <ListField label="Agent Rules" value={projectDraft.agentRules} onChange={(value) => setProjectDraft({ ...projectDraft, agentRules: splitLines(value) })} />
            <ListField label="Validation Commands" value={projectDraft.validationCommands} onChange={(value) => setProjectDraft({ ...projectDraft, validationCommands: splitLines(value) })} />
            <ListField label="Design Rules" value={projectDraft.designRules} onChange={(value) => setProjectDraft({ ...projectDraft, designRules: splitLines(value) })} />
            <ListField label="Glossary" value={projectDraft.glossary} onChange={(value) => setProjectDraft({ ...projectDraft, glossary: splitLines(value) })} />
          </div>

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

function Metric({ label, value }: { label: string; value: number | string }): JSX.Element {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Action({ label, onClick, primary = false }: { label: string; onClick: () => void; primary?: boolean }): JSX.Element {
  return <button className={`action ${primary ? 'actionPrimary' : ''}`} onClick={onClick}>{label}</button>;
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): JSX.Element {
  return <label><span>{label}</span><textarea value={value} onChange={(event) => onChange(event.target.value)} /></label>;
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
