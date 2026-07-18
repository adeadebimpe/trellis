import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type TaskStatus = 'backlog' | 'ready-for-agent' | 'building' | 'ready-for-qa' | 'qa-running' | 'failed-qa' | 'human-review' | 'done';
type AssignedAgent = 'claude' | 'codex' | 'unassigned';
type Priority = 'high' | 'medium' | 'low';
type IntakeIntent = 'single-task' | 'decompose' | 'define' | 'investigate';

interface ActivityEntry {
  timestamp: string;
  actor: string;
  message: string;
}

interface TaskComment {
  id: string;
  author: string;
  phase: 'human-review' | 'failed-qa';
  message: string;
  createdAt: string;
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
  comments?: TaskComment[];
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
  intake?: {
    method: 'manual' | 'agent' | 'cli' | 'api' | 'plugin' | 'webhook' | 'repository-signal';
    text: string;
    sourceUrl?: string;
    attachments: Array<{ name: string; path: string; mediaType: string; size: number }>;
    intent: IntakeIntent;
    createdAt: string;
  };
  lastUpdated: string;
}

interface ProjectContext {
  version: 1;
  contextMode?: 'lean' | 'standard' | 'full';
  contextProfiles?: {
    frontend?: string;
    backend?: string;
    infrastructure?: string;
  };
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
  generatingIds: string[];
  settings: {
    specProvider?: string;
    specProviderLabel: string;
    setupComplete: boolean;
    autoAssignAgent: AssignedAgent;
  };
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
};

const vscode = acquireVsCodeApi();

// Explicit host flag stamped on <body> by getHtml() in src/extension.ts —
// collapse affordances exist only in the narrow sidebar host.
const hostMode: 'sidebar' | 'panel' = document.body.dataset.host === 'sidebar' ? 'sidebar' : 'panel';

function readCollapsedLanes(): Record<string, boolean> {
  const saved = vscode.getState()?.collapsedLanes;
  return saved && typeof saved === 'object' ? (saved as Record<string, boolean>) : {};
}

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
  const [collapsedLanes, setCollapsedLanes] = useState<Record<string, boolean>>(readCollapsedLanes);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [projectSaveState, setProjectSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeStep, setIntakeStep] = useState<1 | 2>(1);
  const [intakeText, setIntakeText] = useState('');
  const [intakeUrl, setIntakeUrl] = useState('');
  const [intakeIntent, setIntakeIntent] = useState<IntakeIntent>('single-task');
  const [intakeFiles, setIntakeFiles] = useState<Array<{ name: string; path: string }>>([]);
  const [intakeSubmitting, setIntakeSubmitting] = useState(false);
  const [generatingIds, setGeneratingIds] = useState<string[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const dirtyRef = useRef(false);
  const draftRef = useRef<Task | null>(null);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const lastKnownUpdatedRef = useRef<string | undefined>(undefined);
  const projectSaveTimer = useRef<number | undefined>(undefined);
  const projectDraftRef = useRef<ProjectContext | null>(null);
  const projectDirty = useRef(false);
  const projectEditVersion = useRef(0);
  const projectSentVersion = useRef(0);
  const [reviewFeedback, setReviewFeedback] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const selected = state?.tasks.find((task) => task.id === selectedId) ?? null;

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    projectDraftRef.current = projectDraft;
  }, [projectDraft]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data.type === 'state') {
        setState(event.data.state);
        // Restore in-flight PRD indicators after the webview is closed and reopened.
        setGeneratingIds(event.data.state.generatingIds ?? []);
        if (selectedId) {
          const fresh = event.data.state.tasks.find((task: Task) => task.id === selectedId);
          if (fresh) {
            lastKnownUpdatedRef.current = fresh.lastUpdated;
            // Never clobber in-progress typing; the pending autosave will persist it.
            if (!dirtyRef.current) {
              setDraft(cloneTask(fresh));
            }
          } else {
            setDraft(null);
          }
        }
        if (projectOpen) {
          if (!projectDirty.current) {
            setProjectDraft(cloneProject(event.data.state.project));
          }
        }
      }
      if (event.data.type === 'saved') {
        setSaveState('saved');
        window.setTimeout(() => setSaveState('idle'), 1400);
      }
      if (event.data.type === 'error') {
        setSaveState('error');
        setProjectSaveState('error');
        setReviewSubmitting(false);
        setIntakeSubmitting(false);
      }
      if (event.data.type === 'saved-project') {
        if (projectEditVersion.current === projectSentVersion.current) {
          projectDirty.current = false;
          setProjectSaveState('saved');
          window.setTimeout(() => setProjectSaveState('idle'), 2200);
        }
      }
      if (event.data.type === 'open-project-context') {
        const project = event.data.project ?? state?.project;
        if (project) {
          setProjectDraft(cloneProject(project));
          setProjectOpen(true);
        }
      }
      if (event.data.type === 'review-feedback-sent') {
        setReviewFeedback('');
        setReviewSubmitting(false);
      }
      if (event.data.type === 'select-task') {
        setSelectedId(event.data.id);
      }
      if (event.data.type === 'auto-select-task') {
        // Open the finished task only if the user has not focused another task meanwhile.
        setSelectedId((current) => (current === null ? event.data.id : current));
      }
      if (event.data.type === 'spec-generating') {
        setGeneratingIds((ids) => (ids.includes(event.data.id) ? ids : [...ids, event.data.id]));
      }
      if (event.data.type === 'spec-generated') {
        setGeneratingIds((ids) => ids.filter((id) => id !== event.data.id));
      }
      if (event.data.type === 'task-deleted') {
        setSelectedId(null);
        setDraft(null);
      }
      if (event.data.type === 'intake-files-selected') {
        setIntakeFiles(event.data.files ?? []);
      }
      if (event.data.type === 'intake-created') {
        setIntakeSubmitting(false);
        setIntakeOpen(false);
        setIntakeStep(1);
        setIntakeText('');
        setIntakeUrl('');
        setIntakeIntent('single-task');
        setIntakeFiles([]);
        setSelectedId(event.data.id);
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
  }, [selectedId, projectOpen, state?.project]);

  useEffect(() => () => {
    if (projectSaveTimer.current !== undefined) {
      window.clearTimeout(projectSaveTimer.current);
    }
  }, []);

  const flushPendingSave = () => {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    if (dirtyRef.current && draftRef.current) {
      dirtyRef.current = false;
      vscode.postMessage({ type: 'save-task', task: draftRef.current, expectedLastUpdated: lastKnownUpdatedRef.current });
    }
  };

  useEffect(() => {
    // Switching tasks (or closing): persist unsaved edits from the previous draft first.
    flushPendingSave();
    setDraft(selected ? cloneTask(selected) : null);
    lastKnownUpdatedRef.current = selected?.lastUpdated;
    setConfirmDelete(false);
    setDetailsOpen(false);
    setActivityOpen(false);
    if (selectedId) {
      setComposerOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setReviewFeedback('');
    setReviewSubmitting(false);
  }, [selectedId]);

  const updateDraft = (next: Task) => {
    setDraft(next);
    dirtyRef.current = true;
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined;
      if (!draftRef.current) {
        return;
      }
      dirtyRef.current = false;
      setSaveState('saving');
      vscode.postMessage({ type: 'save-task', task: draftRef.current, expectedLastUpdated: lastKnownUpdatedRef.current });
    }, 600);
  };

  const saveDraftNow = (next: Task) => {
    setDraft(next);
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    dirtyRef.current = false;
    setSaveState('saving');
    vscode.postMessage({ type: 'save-task', task: next, expectedLastUpdated: lastKnownUpdatedRef.current });
  };

  const sendAction = (task: Task, action: string) => {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    dirtyRef.current = false;
    vscode.postMessage({ type: 'action', id: task.id, task, action, expectedLastUpdated: lastKnownUpdatedRef.current ?? task.lastUpdated });
  };

  const submitComposer = () => {
    const brief = composerText.trim();
    if (!brief) {
      return;
    }
    vscode.postMessage({ type: 'create-task', brief });
    setComposerText('');
    setComposerOpen(false);
  };

  const moveTask = (id: string, status: TaskStatus) => {
    const task = state?.tasks.find((item) => item.id === id);
    vscode.postMessage({ type: 'move-task', id, status, expectedLastUpdated: task?.lastUpdated });
  };

  const toggleLane = (id: TaskStatus) => {
    setCollapsedLanes((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      vscode.setState({ ...(vscode.getState() ?? {}), collapsedLanes: next });
      return next;
    });
  };

  const updateProject = (next: ProjectContext) => {
    setProjectDraft(next);
    projectDraftRef.current = next;
    projectDirty.current = true;
    projectEditVersion.current += 1;
    setProjectSaveState('saving');
    if (projectSaveTimer.current !== undefined) {
      window.clearTimeout(projectSaveTimer.current);
    }
    projectSaveTimer.current = window.setTimeout(() => {
      const current = projectDraftRef.current;
      if (current) {
        projectSentVersion.current = projectEditVersion.current;
        vscode.postMessage({ type: 'save-project', project: current });
      }
    }, 700);
  };

  const closeProject = () => {
    if (projectSaveTimer.current !== undefined) {
      window.clearTimeout(projectSaveTimer.current);
      projectSaveTimer.current = undefined;
    }
    if (projectDirty.current && projectDraftRef.current) {
      projectSentVersion.current = projectEditVersion.current;
      vscode.postMessage({ type: 'save-project', project: projectDraftRef.current });
    }
    setProjectDraft(null);
    setProjectOpen(false);
  };

  if (state && !state.settings.setupComplete) {
    return (
      <main className="shell">
        <section className="setupScreen" aria-label="Trellis setup">
          <div className="setupPanel">
            <p className="eyebrow">First run setup</p>
            <h1>Connect Trellis</h1>
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
          <h1>Trellis</h1>
        </div>
        {generatingIds.length > 0 && (
          <p className="topbarNote">Drafting PRD… You can close this — generation continues in the background.</p>
        )}
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
          <button className="primary" onClick={() => setIntakeOpen(true)}>New task</button>
        </div>
      </header>

      {state && state.tasks.length === 0 ? (
        <section className="emptyBoard">
          <div>
            <h2>No tasks yet</h2>
            <p>Describe what you want built. Trellis drafts the PRD, assigns an agent, and queues it on the board.</p>
            <button className="primary" onClick={() => setIntakeOpen(true)}>New task</button>
          </div>
        </section>
      ) : (
      <section className="board" aria-label="Trellis columns">
        {state?.board.columns.map((column) => {
          const tasks = state.tasks.filter((task) => task.status === column.id);
          const collapsed = hostMode === 'sidebar' && Boolean(collapsedLanes[column.id]);
          return (
            <div
              className={`lane${collapsed ? ' laneCollapsed' : ''}${collapsed && dropTarget === column.id ? ' laneDropTarget' : ''}`}
              key={column.id}
              onDragOver={(event) => {
                event.preventDefault();
                if (collapsed) setDropTarget(column.id);
              }}
              onDragLeave={() => setDropTarget((current) => (current === column.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                if (dragId) moveTask(dragId, column.id);
                setDragId(null);
                setDropTarget(null);
              }}
            >
              <div className="laneHeader">
                {hostMode === 'sidebar' ? (
                  <button
                    className="laneToggle"
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${column.title}`}
                    onClick={() => toggleLane(column.id)}
                  >
                    <span className={`chevron${collapsed ? ' chevronCollapsed' : ''}`} aria-hidden="true">▾</span>
                    <h2>{column.title}</h2>
                  </button>
                ) : (
                  <div>
                    <h2>{column.title}</h2>
                    <p>{statusHints[column.id]}</p>
                  </div>
                )}
                <span>{tasks.length}</span>
              </div>
              {!collapsed && (
              <div className="cards">
                {tasks.map((task) => (
                  <button
                    className={`card priority-${task.priority}`}
                    draggable
                    key={task.id}
                    onClick={() => setSelectedId(task.id)}
                    onDragStart={() => setDragId(task.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropTarget(null);
                    }}
                  >
                    <span className="cardMeta">
                      <strong>{task.id}</strong>
                      <em>{task.priority}</em>
                    </span>
                    <span className="cardTitle" title={task.title || 'Untitled task'}>{task.title || 'Untitled task'}</span>
                    <span className="agentLine">
                      <span>{task.assignedAgent}</span>
                      <span>{generatingIds.includes(task.id) ? 'drafting…' : task.status === 'qa-running' ? task.qaClaimedBy || 'qa' : task.claimedBy || 'unclaimed'}</span>
                    </span>
                  </button>
                ))}
              </div>
              )}
            </div>
          );
        })}
      </section>
      )}

      {intakeOpen && !draft && (
        <div className="intakeBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !intakeSubmitting) setIntakeOpen(false);
        }}>
          <section className="intakePanel" role="dialog" aria-modal="true" aria-labelledby="intake-title">
            <header className="intakeHeader">
              <div>
                <p className="eyebrow">New intake · {intakeStep === 1 ? 'Capture' : 'Review'}</p>
                <h2 id="intake-title">Turn source material into work</h2>
              </div>
              <button className="ghost" disabled={intakeSubmitting} onClick={() => setIntakeOpen(false)}>Close</button>
            </header>

            {intakeStep === 1 ? (
              <div className="intakeBody">
                <label className="intakeField">
                  <span>Source material</span>
                  <textarea autoFocus rows={8} value={intakeText} onChange={(event) => setIntakeText(event.target.value)} placeholder="Paste a ticket, PRD, bug report, or describe what needs to happen…" />
                  <small>Paste from any tool. Trellis does not connect to or synchronize with it.</small>
                </label>
                <label className="intakeField">
                  <span>Source URL <em>optional</em></span>
                  <input type="url" value={intakeUrl} onChange={(event) => setIntakeUrl(event.target.value)} placeholder="https://…" />
                  <small>Stored as provenance only. Trellis will never fetch this URL.</small>
                </label>
                <div className="intakeField">
                  <span>Images and files <em>optional</em></span>
                  <button className="attachmentPicker" onClick={() => vscode.postMessage({ type: 'select-intake-files' })}>
                    <strong>{intakeFiles.length ? `${intakeFiles.length} selected` : 'Choose files'}</strong>
                    <small>Screenshots, images, PDF, Markdown, text, or logs</small>
                  </button>
                  {intakeFiles.length > 0 && <ul className="attachmentList">{intakeFiles.map((file) => <li key={file.path}>{file.name}</li>)}</ul>}
                </div>
                <fieldset className="intentGrid">
                  <legend>What should Trellis do?</legend>
                  {([
                    ['single-task', 'One task', 'Shape this into a focused implementation draft.'],
                    ['decompose', 'Break it down', 'Find coherent task boundaries and start with the first.'],
                    ['define', 'Help define it', 'Surface gaps and turn the idea into requirements.'],
                    ['investigate', 'Investigate', 'Create a diagnostic task before choosing a fix.']
                  ] as Array<[IntakeIntent, string, string]>).map(([value, label, hint]) => (
                    <label className={`intentCard${intakeIntent === value ? ' intentCardSelected' : ''}`} key={value}>
                      <input type="radio" name="intake-intent" value={value} checked={intakeIntent === value} onChange={() => setIntakeIntent(value)} />
                      <strong>{label}</strong><small>{hint}</small>
                    </label>
                  ))}
                </fieldset>
              </div>
            ) : (
              <div className="intakeBody intakeReview">
                <p className="reviewKicker">Nothing starts until you approve the generated draft.</p>
                <dl>
                  <div><dt>Intent</dt><dd>{intakeIntent.replace('-', ' ')}</dd></div>
                  <div><dt>Source</dt><dd>{intakeUrl || 'No external URL'}</dd></div>
                  <div><dt>Attachments</dt><dd>{intakeFiles.length || 'None'}</dd></div>
                </dl>
                <div className="reviewExcerpt"><span>Submitted material</span><p>{intakeText}</p></div>
              </div>
            )}

            <footer className="intakeActions">
              {intakeStep === 2 && <button className="ghost" disabled={intakeSubmitting} onClick={() => setIntakeStep(1)}>Back</button>}
              <span>The result stays in Backlog for editing.</span>
              {intakeStep === 1 ? (
                <button className="primary" disabled={!intakeText.trim()} onClick={() => setIntakeStep(2)}>Review intake</button>
              ) : (
                <button className="primary" disabled={intakeSubmitting} onClick={() => {
                  setIntakeSubmitting(true);
                  vscode.postMessage({ type: 'create-intake', intake: { text: intakeText, sourceUrl: intakeUrl, intent: intakeIntent, attachmentPaths: intakeFiles.map((file) => file.path) } });
                }}>{intakeSubmitting ? 'Drafting…' : 'Create editable draft'}</button>
              )}
            </footer>
          </section>
        </div>
      )}

      {state && composerOpen && !draft && (
        <footer className="composerBar" aria-label="New task composer">
          <div className="composerBox">
            <textarea
              autoFocus
              rows={2}
              placeholder="Describe a task. Enter generates the PRD; Shift+Enter adds a new line."
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submitComposer();
                }
                if (event.key === 'Escape') {
                  setComposerOpen(false);
                }
              }}
            />
            <div className="composerControls">
              <span className="composerHint">
                {state.settings.autoAssignAgent === 'unassigned'
                  ? 'No agent CLI detected — task starts unassigned'
                  : `Build and QA auto-assigned to ${state.settings.autoAssignAgent}`}
              </span>
              <button className="primary composerSubmit" disabled={!composerText.trim()} onClick={submitComposer}>Generate PRD</button>
            </div>
          </div>
        </footer>
      )}

      {draft && (
        <aside className="drawer" aria-label="Task drawer">
          <div className="drawerHeader">
            <div>
              <p className="eyebrow">
                {draft.id} · {draft.status}
                {saveState === 'saving' && ' · saving…'}
                {saveState === 'saved' && ' · saved'}
                {saveState === 'error' && ' · save failed'}
              </p>
              <input className="titleInput" placeholder="Untitled task" title={draft.title || undefined} value={draft.title} onChange={(event) => updateDraft({ ...draft, title: event.target.value })} />
            </div>
            <div className="drawerHeaderActions">
              <button
                className="danger dangerSmall"
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
                {confirmDelete ? 'Confirm?' : 'Delete'}
              </button>
              <button className="ghost" onClick={() => setSelectedId(null)}>Close</button>
            </div>
          </div>

          <div className="props">
            <label className="propRow">
              <span>Status</span>
              <select
                value={draft.status}
                onChange={(event) => {
                  const status = event.target.value as TaskStatus;
                  setDraft({ ...draft, status });
                  vscode.postMessage({ type: 'move-task', id: draft.id, status, expectedLastUpdated: lastKnownUpdatedRef.current });
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
            <label className="propRow">
              <span>Priority</span>
              <select value={draft.priority} onChange={(event) => saveDraftNow({ ...draft, priority: event.target.value as Priority })}>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </label>
            <label className="propRow">
              <span>Agent</span>
              <select value={draft.assignedAgent} onChange={(event) => saveDraftNow({ ...draft, assignedAgent: event.target.value as AssignedAgent })}>
                <option value="unassigned">unassigned</option>
                <option value="claude">claude</option>
                <option value="codex">codex</option>
              </select>
            </label>
            <label className="propRow">
              <span>QA</span>
              <select value={draft.qaAgent} onChange={(event) => saveDraftNow({ ...draft, qaAgent: event.target.value as AssignedAgent })}>
                <option value="unassigned">unassigned</option>
                <option value="claude">claude</option>
                <option value="codex">codex</option>
              </select>
            </label>
          </div>

          <div className="actions">
            {draft.status === 'backlog' && (
              <Action
                label={generatingIds.includes(draft.id) ? 'Drafting PRD…' : 'Generate PRD'}
                onClick={() => sendAction(draft, 'generate-spec')}
                primary
                disabled={!draft.brief.trim() || generatingIds.includes(draft.id)}
                title={!draft.brief.trim() ? 'This task has no brief. Create tasks from the New task box so the PRD has a source.' : undefined}
              />
            )}
            {draft.status === 'ready-for-agent' && (
              <Action
                label="Start build"
                onClick={() => sendAction(draft, 'start-build')}
                primary
                disabled={draft.assignedAgent === 'unassigned'}
                title={draft.assignedAgent === 'unassigned' ? 'Assign Claude or Codex first.' : undefined}
              />
            )}
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
            {draft.status === 'failed-qa' && <p className="automationHint">Add context below while this task waits to return to Building.</p>}
            {draft.status === 'qa-running' && (
              <p className="automationHint">QA is running and will record pass or fail automatically.</p>
            )}
            {state?.liveTerminals?.includes(draft.id) && (
              <Action label="Show agent terminal" onClick={() => vscode.postMessage({ type: 'show-terminal', id: draft.id })} />
            )}
            {(draft.comments ?? []).length > 0 && (
              <section className="commentHistory" aria-label="Agent comments">
                <div className="commentHistoryHeader">Comments <span>{draft.comments!.length}</span></div>
                {draft.comments!.slice().reverse().map((comment) => (
                  <article className="commentItem" key={comment.id}>
                    <div><strong>{comment.author}</strong><span>{comment.phase.replace('-', ' ')}</span><time>{formatTimelineTime(comment.createdAt)}</time></div>
                    <p>{comment.message}</p>
                  </article>
                ))}
              </section>
            )}
            {(draft.status === 'human-review' || draft.status === 'failed-qa') && (
              <section className="reviewPanel" aria-label="Comment and send to agent">
                <div>
                  <span className="reviewLabel">Comment to agent</span>
                  <p>Add the missing context or requested change. It stays with the task and the build agent starts immediately.</p>
                </div>
                <textarea
                  value={reviewFeedback}
                  onChange={(event) => setReviewFeedback(event.target.value)}
                  placeholder="For example: Keep the inferred context editable after saving, and preserve my existing architecture notes."
                  rows={4}
                />
                <button
                  className="danger reviewSubmit"
                  disabled={!reviewFeedback.trim() || reviewSubmitting || draft.assignedAgent === 'unassigned'}
                  title={draft.assignedAgent === 'unassigned' ? 'Assign a build agent before requesting changes.' : undefined}
                  onClick={() => {
                    setReviewSubmitting(true);
                    vscode.postMessage({
                      type: 'request-changes',
                      id: draft.id,
                      feedback: reviewFeedback,
                      expectedLastUpdated: lastKnownUpdatedRef.current
                    });
                  }}
                >
                  {reviewSubmitting ? 'Sending…' : 'Comment & send to Building'}
                </button>
              </section>
            )}
            {draft.status === 'human-review' && (
              <Action label="Ship (PR / merge)" onClick={() => vscode.postMessage({ type: 'ship-task', id: draft.id, expectedLastUpdated: lastKnownUpdatedRef.current })} primary />
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

          {generatingIds.includes(draft.id) && (
            <p className="draftingNote">Drafting title, PRD, and checklists from the brief…</p>
          )}

          <div className="fields">
            <Field label="PRD Description" value={draft.description} onChange={(value) => updateDraft({ ...draft, description: value })} />
            <ListField label="Acceptance Criteria" value={draft.acceptanceCriteria} onChange={(value) => updateDraft({ ...draft, acceptanceCriteria: splitLines(value) })} />
          </div>

          <button className="sectionToggle" onClick={() => setDetailsOpen((open) => !open)}>
            {detailsOpen ? '▾' : '▸'} Details
          </button>
          {detailsOpen && (hasTaskDetails(draft) ? (
            <div className="detailSections">
              <DetailList label="QA Checklist" items={draft.qaChecklist} />
              <DetailList label="Design QA Checklist" items={draft.designQaChecklist} />
              <DetailList label="Validation Commands" items={draft.validationCommands} />
              <DetailList label="Relevant Files" items={draft.relevantFiles} />
              <DetailList label="Constraints" items={draft.constraints} />
              <DetailText label="Agent Notes" text={draft.agentNotes} />
              <DetailList label="QA Evidence" items={draft.qaEvidence} />
              <DetailText label="Branch" text={draft.branchName} />
            </div>
          ) : (
            <p className="detailEmpty">Checklists, files, and notes filled in by agents will appear here.</p>
          ))}

          <Timeline
            open={activityOpen}
            onToggle={() => setActivityOpen((open) => !open)}
            entries={[...(draft.activityLog ?? []), ...(draft.qaNotes ?? [])]}
          />
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
              closeProject();
            }}>Skip for now</button>
          </div>

          <div className="contextIntro">
            <span className="contextOptional">Optional</span>
            <p>Give every agent the same product and repository context. Start with a repo scan, add your own notes, or come back from the menu whenever you need it.</p>
          </div>

          <fieldset className="contextModeGroup">
            <legend>Context mode</legend>
            <div className="contextModeOptions">
              {(['lean', 'standard', 'full'] as const).map((mode) => (
                <label className={(projectDraft.contextMode ?? 'standard') === mode ? 'selected' : ''} key={mode}>
                  <input
                    type="radio"
                    name="context-mode"
                    value={mode}
                    checked={(projectDraft.contextMode ?? 'standard') === mode}
                    onChange={() => updateProject({ ...projectDraft, contextMode: mode })}
                  />
                  <span>{mode[0].toUpperCase() + mode.slice(1)}</span>
                </label>
              ))}
            </div>
            <p className="contextBudget">≈ {estimateContextTokens(projectDraft).toLocaleString()} prompt tokens · estimate updates as you type</p>
          </fieldset>

          <div className="contextBlock">
            <Field
              label="Project context"
              big
              placeholder="Paste anything agents should know before building: product overview, architecture notes, conventions, constraints, links. This goes to PRD generation and is stored in .agent-board/project.json for agents."
              value={projectDraft.contextNotes ?? ''}
              onChange={(value) => updateProject({ ...projectDraft, contextNotes: value })}
            />
          </div>

          <div className="contextActions">
            <button
              className="primary"
              disabled={projectSaveState === 'saving'}
              onClick={() => {
                setProjectSaveState('saving');
                setProjectFieldsOpen(true);
                vscode.postMessage({ type: 'infer-project' });
              }}
            >
              Infer from repo
            </button>
            <p className={`autosaveStatus ${projectSaveState}`} role="status" aria-live="polite">
              {projectSaveState === 'saving' && 'Saving changes…'}
              {projectSaveState === 'saved' && 'Saved automatically'}
              {projectSaveState === 'error' && 'Could not save — your edits are still here'}
              {projectSaveState === 'idle' && `Autosaved · ${new Date(projectDraft.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
            </p>
          </div>

          <div className="contextBlock">
            <ListField label="Validation commands (used by QA runs, one per line)" value={projectDraft.validationCommands} onChange={(value) => updateProject({ ...projectDraft, validationCommands: splitLines(value) })} />
          </div>

          <button className="sectionToggle" onClick={() => setProjectFieldsOpen((open) => !open)}>
            {projectFieldsOpen ? '▾' : '▸'} Structured fields (optional)
          </button>
          {projectFieldsOpen && (
            <div className="formGrid">
              <Field label="Project overview" value={projectDraft.overview} onChange={(value) => updateProject({ ...projectDraft, overview: value })} />
              <ListField label="Project goals" value={projectDraft.goals} onChange={(value) => updateProject({ ...projectDraft, goals: splitLines(value) })} />
              <Field label="Architecture notes" value={projectDraft.architectureNotes} onChange={(value) => updateProject({ ...projectDraft, architectureNotes: value })} />
              <ListField label="Coding rules" value={projectDraft.codingRules} onChange={(value) => updateProject({ ...projectDraft, codingRules: splitLines(value) })} />
              <ListField label="Agent rules" value={projectDraft.agentRules} onChange={(value) => updateProject({ ...projectDraft, agentRules: splitLines(value) })} />
              <ListField label="Design rules" value={projectDraft.designRules} onChange={(value) => updateProject({ ...projectDraft, designRules: splitLines(value) })} />
              <ListField label="Glossary" value={projectDraft.glossary} onChange={(value) => updateProject({ ...projectDraft, glossary: splitLines(value) })} />
              <Field label="Frontend routing card" placeholder="UI architecture, component conventions, and key frontend paths." value={projectDraft.contextProfiles?.frontend ?? ''} onChange={(value) => updateProject({ ...projectDraft, contextProfiles: { ...projectDraft.contextProfiles, frontend: value } })} />
              <Field label="Backend routing card" placeholder="Service boundaries, persistence conventions, and key backend paths." value={projectDraft.contextProfiles?.backend ?? ''} onChange={(value) => updateProject({ ...projectDraft, contextProfiles: { ...projectDraft.contextProfiles, backend: value } })} />
              <Field label="Infrastructure routing card" placeholder="Deployment, CI, environments, and key infrastructure paths." value={projectDraft.contextProfiles?.infrastructure ?? ''} onChange={(value) => updateProject({ ...projectDraft, contextProfiles: { ...projectDraft.contextProfiles, infrastructure: value } })} />
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

function hasTaskDetails(task: Task): boolean {
  return Boolean(
    task.qaChecklist?.length ||
    task.designQaChecklist?.length ||
    task.validationCommands?.length ||
    task.relevantFiles?.length ||
    task.constraints?.length ||
    task.agentNotes?.trim() ||
    task.qaEvidence?.length ||
    task.branchName?.trim()
  );
}

function DetailList({ label, items }: { label: string; items: string[] }): JSX.Element | null {
  if (!items?.length) {
    return null;
  }
  return (
    <div className="detailBlock">
      <h4>{label}</h4>
      <ul>
        {items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
      </ul>
    </div>
  );
}

function DetailText({ label, text }: { label: string; text: string }): JSX.Element | null {
  if (!text?.trim()) {
    return null;
  }
  return (
    <div className="detailBlock">
      <h4>{label}</h4>
      <p>{text}</p>
    </div>
  );
}

function formatTimelineTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Timeline({ entries, open, onToggle }: { entries: ActivityEntry[]; open: boolean; onToggle: () => void }): JSX.Element | null {
  if (!entries.length) {
    return null;
  }
  const sorted = entries.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return (
    <section className="timeline">
      <button className="sectionToggle" onClick={onToggle}>
        {open ? '▾' : '▸'} Activity <span className="sectionCount">{sorted.length}</span>
      </button>
      {open && sorted.map((entry, index) => (
        <div className="timelineRow" key={`${entry.timestamp}-${index}`}>
          <time>{formatTimelineTime(entry.timestamp)}</time>
          <span className="timelineActor">{entry.actor}</span>
          <span className="timelineMessage">{entry.message}</span>
        </div>
      ))}
    </section>
  );
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

function estimateContextTokens(project: ProjectContext): number {
  const mode = project.contextMode ?? 'standard';
  const lean = {
    codingRules: project.codingRules,
    agentRules: project.agentRules,
    validationCommands: project.validationCommands,
    designRules: project.designRules,
    relevantFiles: project.inference?.detectedFiles,
    contextProfiles: project.contextProfiles
  };
  const selected = mode === 'lean' ? lean : {
    ...lean,
    contextNotes: project.contextNotes,
    overview: project.overview,
    goals: project.goals,
    architectureNotes: project.architectureNotes,
    glossary: project.glossary,
    inference: project.inference
  };
  return Math.max(1, Math.ceil(JSON.stringify(selected).length / 4));
}

createRoot(document.getElementById('root')!).render(<App />);
