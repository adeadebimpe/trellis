import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { ArrowLeftIcon, ArrowUpIcon, AtSignIcon, BookmarkIcon, BugIcon, ChevronDownIcon, ChevronRightIcon, EllipsisVerticalIcon, FileTextIcon, LayoutGridIcon, LoaderPinwheelIcon, PlusCircleIcon, PlusIcon, PriorityIcon, SparklesIcon, TrellisLogo, XIcon } from './icons';
import { PendingIntake, queueIntake, updateIntake } from './intakeState';

type TaskStatus = 'backlog' | 'ready-for-agent' | 'building' | 'ready-for-qa' | 'qa-running' | 'failed-qa' | 'human-review' | 'done' | 'merged';
type AssignedAgent = 'claude' | 'codex' | 'unassigned';
type Priority = 'high' | 'medium' | 'low';
type IntakeIntent = 'single-task' | 'decompose' | 'define' | 'investigate';
type WorkflowMode = 'branch-per-task' | 'direct-on-main';
type IntakeFile = { key: string; name: string; path?: string; mediaType?: string; base64?: string };

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
  descriptionRichText?: string;
  acceptanceCriteria: string[];
  acceptanceCriteriaRichText?: string;
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
  workflowMode?: WorkflowMode;
  claimWarning?: string;
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
  workflowMode?: WorkflowMode;
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
    projectName?: string;
    projectDescription?: string;
    readmeTitle?: string;
    readmeSummary?: string;
    topLevelDirs?: string[];
    generatedNotes?: string;
    generatedValidation?: string[];
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
  activeRuns: Record<string, {
    phase: 'build' | 'qa';
    agent: Exclude<AssignedAgent, 'unassigned'>;
    surface: 'chat' | 'terminal';
    claimId: string;
    startedAt: string;
  }>;
  generatingIds: string[];
  settings: {
    specProvider?: string;
    specProviderLabel: string;
    setupComplete: boolean;
    autoAssignAgent: AssignedAgent;
    agentPermissions: {
      allowlist: string[];
      codexMode: string;
      autoContinue: boolean;
      enabled: boolean;
      decisionMade: boolean;
    };
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

const statusLabels: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  'ready-for-agent': 'Ready for Agent',
  building: 'Building',
  'ready-for-qa': 'Ready for QA',
  'qa-running': 'QA Running',
  'failed-qa': 'Failed QA',
  'human-review': 'Human Review',
  done: 'Done',
  merged: 'Merged'
};

const statusHints: Record<TaskStatus, string> = {
  backlog: 'Idea intake',
  'ready-for-agent': 'Claimable work',
  building: 'Agent active',
  'ready-for-qa': 'Validation queue',
  'qa-running': 'QA agent active',
  'failed-qa': 'Needs repair',
  'human-review': 'Needs judgment',
  done: 'Closed loop',
  merged: 'Shipped code'
};

const workflowPercent: Record<TaskStatus, number> = {
  backlog: 0,
  'ready-for-agent': 10,
  building: 45,
  'ready-for-qa': 70,
  'qa-running': 85,
  'failed-qa': 70,
  'human-review': 95,
  done: 100,
  merged: 100
};

function App(): JSX.Element {
  const [state, setState] = useState<BoardState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Task | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectContext | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [collapsedLanes, setCollapsedLanes] = useState<Record<string, boolean>>(readCollapsedLanes);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [projectSaveState, setProjectSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [setupWorkflowMode, setSetupWorkflowMode] = useState<WorkflowMode>('branch-per-task');
  const [inferBusy, setInferBusy] = useState(false);
  const [projectOnboarding, setProjectOnboarding] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<'quick' | 'prd' | 'bug'>('quick');
  const [createText, setCreateText] = useState('');
  const [createAgent, setCreateAgent] = useState<AssignedAgent>('unassigned');
  const [intakeFiles, setIntakeFiles] = useState<IntakeFile[]>([]);
  const [pendingIntakes, setPendingIntakes] = useState<PendingIntake[]>([]);
  const [intakeNotice, setIntakeNotice] = useState('');
  const [createQaAgent, setCreateQaAgent] = useState<AssignedAgent>('unassigned');
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [prdSplitting, setPrdSplitting] = useState(false);
  const [createBusy, setCreateBusy] = useState<'task' | 'prd' | null>(null);
  const [generatingIds, setGeneratingIds] = useState<string[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [prdOpen, setPrdOpen] = useState(true);
  const [acOpen, setAcOpen] = useState(true);
  const [detailTab, setDetailTab] = useState<'comments' | 'activity'>('comments');
  const dirtyRef = useRef(false);
  const transientDraftRef = useRef(false);
  const transientCreatingRef = useRef(false);
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
    if (state?.project.workflowMode) setSetupWorkflowMode(state.project.workflowMode);
  }, [state?.project.workflowMode]);

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
        setInferBusy(false);
        setReviewSubmitting(false);
        setPrdSplitting(false);
        if (event.data.requestId) {
          setPendingIntakes((items) => updateIntake(items, event.data.requestId, { state: 'error', message: event.data.message }));
        } else {
          setCreateBusy(null);
        }
      }
      if (event.data.type === 'saved-project') {
        if (projectEditVersion.current === projectSentVersion.current) {
          projectDirty.current = false;
          setProjectSaveState('saved');
          window.setTimeout(() => setProjectSaveState('idle'), 2200);
        }
      }
      if (event.data.type === 'inferred-project') {
        setInferBusy(false);
        const project = event.data.project as ProjectContext;
        if (!projectDirty.current) {
          setProjectDraft(cloneProject(project));
          projectSentVersion.current = projectEditVersion.current;
          setProjectSaveState('saved');
          window.setTimeout(() => setProjectSaveState('idle'), 2200);
        } else {
          // The user typed during the round trip: keep their keystrokes and
          // take only the scan-owned fields (plus seeds for empty fields).
          setProjectDraft((current) => current ? {
            ...current,
            inference: project.inference,
            architectureNotes: project.architectureNotes,
            lastUpdated: project.lastUpdated,
            contextNotes: current.contextNotes.trim() ? current.contextNotes : project.contextNotes,
            validationCommands: current.validationCommands.length ? current.validationCommands : project.validationCommands
          } : cloneProject(project));
        }
      }
      if (event.data.type === 'open-project-context') {
        const project = event.data.project ?? state?.project;
        if (project) {
          setProjectDraft(cloneProject(project));
          setProjectOnboarding(event.data.source === 'onboarding');
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
      if (event.data.type === 'blank-draft-created') {
        const created = event.data.task as Task;
        const keepOpen = transientDraftRef.current;
        transientDraftRef.current = false;
        transientCreatingRef.current = false;
        lastKnownUpdatedRef.current = created.lastUpdated;
        if (keepOpen) {
          setSelectedId(created.id);
          setDraft(cloneTask(created));
        }
        setSaveState('saved');
        window.setTimeout(() => setSaveState('idle'), 1400);
      }
      if (event.data.type === 'fresh-started') {
        setSelectedId(null);
        setDraft(null);
        setProjectDraft(null);
        setProjectOpen(false);
        setProjectOnboarding(false);
        setCreateOpen(false);
      }
      if (event.data.type === 'workspace-files') {
        setWorkspaceFiles(Array.isArray(event.data.files) ? event.data.files : []);
      }
      if (event.data.type === 'intake-files-selected') {
        const files = Array.isArray(event.data.files) ? event.data.files : [];
        setIntakeFiles((current) => {
          const byPath = new Map(current.map((file) => [file.key, file]));
          for (const file of files) {
            if (file && typeof file.name === 'string' && typeof file.path === 'string') {
              byPath.set(file.path, { key: file.path, name: file.name, path: file.path });
            }
          }
          return [...byPath.values()];
        });
      }
      if (event.data.type === 'intake-started') {
        setPendingIntakes((items) => updateIntake(items, event.data.requestId, { state: 'drafting', taskId: event.data.id }));
      }
      if (event.data.type === 'prd-split-started') {
        setPrdSplitting(true);
      }
      if (event.data.type === 'prd-split-done') {
        setPrdSplitting(false);
        setCreateBusy(null);
      }
      if (event.data.type === 'prd-split-created') {
        // Tasks are on the board; leave the create screen if it is still open.
        setCreateBusy(null);
        setCreateText('');
        setIntakeFiles([]);
        setCreateOpen(false);
      }
      if (event.data.type === 'intake-created') {
        setPendingIntakes((items) => updateIntake(items, event.data.requestId, {
          state: event.data.generated ? 'done' : 'error',
          taskId: event.data.id,
          message: event.data.generated ? undefined : 'The task was saved, but its PRD could not be generated.'
        }));
      }
    };
    window.addEventListener('message', listener);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, [selectedId, projectOpen, state?.project, createOpen]);

  useEffect(() => () => {
    if (projectSaveTimer.current !== undefined) {
      window.clearTimeout(projectSaveTimer.current);
    }
  }, []);

  useEffect(() => {
    if (!deleteModalOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDeleteModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteModalOpen]);

  const flushPendingSave = () => {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    if (dirtyRef.current && draftRef.current && !transientDraftRef.current) {
      dirtyRef.current = false;
      vscode.postMessage({ type: 'save-task', task: draftRef.current, expectedLastUpdated: lastKnownUpdatedRef.current });
    }
  };

  useEffect(() => {
    // Switching tasks (or closing): persist unsaved edits from the previous draft first.
    flushPendingSave();
    setDraft(selected ? cloneTask(selected) : null);
    lastKnownUpdatedRef.current = selected?.lastUpdated;
    setDeleteModalOpen(false);
    setMenuOpen(false);
    setDetailsOpen(false);
    setPrdOpen(true);
    setAcOpen(true);
    setDetailTab('comments');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setReviewFeedback('');
    setReviewSubmitting(false);
  }, [selectedId]);

  const updateDraft = (next: Task) => {
    setDraft(next);
    if (transientDraftRef.current) {
      if (saveTimerRef.current !== undefined) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = undefined;
      }
      if (isMeaningfulBlankDraft(next)) {
        saveTimerRef.current = window.setTimeout(() => {
          saveTimerRef.current = undefined;
          if (!draftRef.current || transientCreatingRef.current) return;
          transientCreatingRef.current = true;
          setSaveState('saving');
          vscode.postMessage({ type: 'create-blank-draft', task: draftRef.current });
        }, 600);
      }
      return;
    }
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
    if (transientDraftRef.current) {
      if (isMeaningfulBlankDraft(next) && !transientCreatingRef.current) {
        transientCreatingRef.current = true;
        setSaveState('saving');
        vscode.postMessage({ type: 'create-blank-draft', task: next });
      }
      return;
    }
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

  const openCreate = () => {
    setCreateMode('quick');
    setCreateText('');
    setIntakeFiles([]);
    setMentionQuery(null);
    setCreateAgent(state?.settings.autoAssignAgent ?? 'unassigned');
    setCreateQaAgent(state?.settings.autoAssignAgent ?? 'unassigned');
    setCreateOpen(true);
    vscode.postMessage({ type: 'workspace-files' });
  };

  const openBlankDraft = () => {
    transientDraftRef.current = true;
    transientCreatingRef.current = false;
    dirtyRef.current = false;
    lastKnownUpdatedRef.current = undefined;
    setSelectedId(null);
    setDraft(blankDraft());
    setAddMenuOpen(false);
  };

  const closeDraft = () => {
    if (transientDraftRef.current) {
      if (saveTimerRef.current !== undefined) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = undefined;
      }
      if (draftRef.current && isMeaningfulBlankDraft(draftRef.current) && !transientCreatingRef.current) {
        transientCreatingRef.current = true;
        vscode.postMessage({ type: 'create-blank-draft', task: draftRef.current });
      }
      transientDraftRef.current = false;
      setDraft(null);
      setSaveState('idle');
      return;
    }
    setSelectedId(null);
  };

  const sendCreate = () => {
    const text = createText.trim();
    if (!text || (createMode === 'prd' && (createBusy || prdSplitting))) {
      return;
    }
    if (createMode === 'prd') {
      setCreateBusy('prd');
      vscode.postMessage({ type: 'create-from-prd', prd: text, agent: createAgent, qaAgent: createQaAgent });
    } else {
      const requestId = `intake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const mentions = Array.from(new Set(
        [...text.matchAll(/@([\w./~-]+)/g)].map((match) => match[1]).filter((path) => workspaceFiles.includes(path))
      ));
      vscode.postMessage({
        type: 'create-intake',
        requestId,
        agent: createAgent,
        qaAgent: createQaAgent,
        mentions,
        intake: {
          text,
          intent: createMode === 'bug' ? 'investigate' : 'single-task',
          attachmentPaths: intakeFiles.flatMap((file) => file.path ? [file.path] : []),
          pastedFiles: intakeFiles.flatMap((file) => file.base64 ? [{
            name: file.name,
            mediaType: file.mediaType,
            base64: file.base64
          }] : [])
        }
      });
      setPendingIntakes((items) => queueIntake(items, requestId, text));
      setCreateText('');
      setIntakeFiles([]);
    }
    // Stay on the create screen until the draft lands; the back arrow can
    // dismiss it early and generation continues in the background.
    setMentionQuery(null);
  };

  const pasteIntoComposer = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    const accepted = files.filter((file) =>
      /^(?:image\/(?:png|jpeg|gif|webp)|text\/(?:plain|markdown))$/i.test(file.type)
      || /\.(?:png|jpe?g|gif|webp|md|txt)$/i.test(file.name)
    );
    const rejected = files.filter((file) => !accepted.includes(file));
    if (rejected.length) {
      setIntakeNotice(`Could not attach ${rejected.map((file) => file.name || 'clipboard file').join(', ')}. Use an image, .md, or .txt file.`);
    }
    const loaded = await Promise.all(accepted.map(async (file, index): Promise<IntakeFile | null> => {
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = dataUrl.split(',', 2)[1];
        if (!base64) throw new Error('empty');
        return {
          key: `paste-${Date.now()}-${index}-${file.name}`,
          name: file.name || `pasted-image-${index + 1}.${extensionForMediaType(file.type)}`,
          mediaType: file.type || mediaTypeForFileName(file.name),
          base64
        };
      } catch {
        setIntakeNotice(`${file.name || 'Clipboard file'} could not be read.`);
        return null;
      }
    }));
    setIntakeFiles((current) => [...current, ...loaded.filter((file): file is IntakeFile => file !== null)]);
  };

  const insertMention = (path: string) => {
    setCreateText((current) => {
      if (mentionQuery !== null && current.endsWith(`@${mentionQuery}`)) {
        return `${current.slice(0, current.length - mentionQuery.length - 1)}@${path} `;
      }
      const separator = current && !/\s$/.test(current) ? ' ' : '';
      return `${current}${separator}@${path} `;
    });
    setMentionQuery(null);
  };

  const mentionMatches = mentionQuery === null
    ? []
    : workspaceFiles.filter((file) => file.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8);

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
    setProjectOnboarding(false);
  };

  const boardColumns = state?.board.columns.filter((column) =>
    state.tasks.length === 0
    || column.id !== 'ready-for-qa'
    || state.tasks.some((task) => task.status === 'ready-for-qa')
  ) ?? [];

  if (state && (!state.settings.agentPermissions.decisionMade || permissionsOpen)) {
    const permissions = state.settings.agentPermissions;
    return (
      <main className="shell">
        <section className="setupScreen" aria-label="Agent workflow permissions">
          <div className="setupPanel">
            <p className="eyebrow">Agent permissions</p>
            <h1>{permissions.enabled ? 'Standard workflow is pre-authorized' : 'Let agents finish without repeated prompts?'}</h1>
            <p>
              Trellis can authorize the standard workflow once. Claude Code receives the exact allowlist below; Codex runs non-interactively inside its workspace-write sandbox. You can revoke this later from the board menu. Push, hard reset, file deletion, and full-access bypass are not included.
            </p>
            <p className="permissionMode"><strong>Codex mode</strong><code>{permissions.codexMode}</code></p>
            <ul className="permissionList">
              {permissions.allowlist.map((entry) => <li key={entry}><code>{entry}</code></li>)}
            </ul>
            <label className="automationToggle">
              <span>
                <strong>Automatically start the next task</strong>
                <small>Trellis opens a terminal only when no chat or terminal run already owns that task.</small>
              </span>
              <input
                type="checkbox"
                checked={permissions.autoContinue}
                onChange={(event) => vscode.postMessage({ type: 'set-auto-continue', enabled: event.target.checked })}
              />
              <i aria-hidden="true" />
            </label>
            <div className="setupActions">
              {permissions.enabled ? (
                <button className="danger" onClick={() => {
                  vscode.postMessage({ type: 'configure-agent-permissions', action: 'revoke' });
                  setPermissionsOpen(false);
                }}>Revoke Trellis permissions</button>
              ) : (
                <button className="primary" onClick={() => {
                  vscode.postMessage({ type: 'configure-agent-permissions', action: 'grant' });
                  setPermissionsOpen(false);
                }}>Allow standard workflow</button>
              )}
              <button className="ghost" onClick={() => {
                if (!permissions.decisionMade) vscode.postMessage({ type: 'configure-agent-permissions', action: 'decline' });
                setPermissionsOpen(false);
              }}>{permissions.decisionMade ? 'Back to board' : 'Not now'}</button>
            </div>
          </div>
        </section>
      </main>
    );
  }

  if (state && !state.settings.setupComplete) {
    const chooseSetupMode = (mode: WorkflowMode) => setSetupWorkflowMode(mode);
    const setupMessage = (type: string) => vscode.postMessage({ type, workflowMode: setupWorkflowMode });
    return (
      <main className="shell">
        <section className="setupScreen" aria-label="Trellis setup">
          <div className="setupPanel">
            <p className="eyebrow">First run setup</p>
            <h1>Connect Trellis</h1>
            <p>
              Sign in once with the agent CLI you want to use for PRD generation and task execution. Codex and Claude keep their own credentials, so you do not need to sign in again on every refresh.
            </p>
            <WorkflowModePicker value={setupWorkflowMode} onChange={chooseSetupMode} setup />
            <div className="setupActions">
              <button className="primary" onClick={() => setupMessage('sign-in-codex')}>Sign in to Codex</button>
              <button className="primary" onClick={() => setupMessage('sign-in-claude')}>Sign in to Claude</button>
              <button className="ghost" onClick={() => setupMessage('continue-to-board')}>Continue to board</button>
            </div>
            <p className="setupStatus">PRD generator: {state.settings.specProviderLabel}</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      {/* The panel host keeps the board visible and overlays details as a drawer. */}
      {(hostMode === 'panel' || (!draft && !projectDraft && !createOpen)) && (
      <>
      <header className="topbar">
        <div className="topbarLeft">
          <TrellisLogo />
          <h1>Trellis</h1>
        </div>
        {(generatingIds.length > 0 || prdSplitting) && (
          <p className="topbarNote">{prdSplitting ? 'Bulk generating tasks…' : 'Drafting PRD… You can close this — generation continues in the background.'}</p>
        )}
        <div className="telemetry">
          <div className="menuWrap">
            <button className="iconButton" aria-label="New task" title="New task" onClick={() => setAddMenuOpen((open) => !open)}>
              <PlusCircleIcon />
            </button>
            {addMenuOpen && (
              <>
                <div className="menuOverlay" onClick={() => setAddMenuOpen(false)} />
                <div className="menu" role="menu">
                  <button role="menuitem" onClick={() => {
                    setAddMenuOpen(false);
                    openCreate();
                  }}>Create with agent</button>
                  <button role="menuitem" onClick={() => {
                    openBlankDraft();
                  }}>Blank task</button>
                </div>
              </>
            )}
          </div>
          <div className="menuWrap">
            <button className="iconButton" aria-label="More actions" title="More actions" onClick={() => setMenuOpen((open) => !open)}>
              <EllipsisVerticalIcon />
            </button>
            {menuOpen && (
              <>
                <div className="menuOverlay" onClick={() => setMenuOpen(false)} />
                <div className="menu" role="menu">
                  <p className="menuStatus">PRD: {state?.settings.specProviderLabel ?? 'Not configured'}</p>
                  <button role="menuitem" onClick={() => {
                    setMenuOpen(false);
                    if (state?.project) {
                      setProjectDraft(cloneProject(state.project));
                      setProjectOnboarding(false);
                      setProjectOpen(true);
                    }
                  }}>Project context</button>
                  <button role="menuitem" onClick={() => {
                    setMenuOpen(false);
                    vscode.postMessage({ type: 'sign-in-agents' });
                  }}>Agent sign in</button>
                  <button role="menuitem" onClick={() => {
                    setMenuOpen(false);
                    setPermissionsOpen(true);
                  }}>Agent permissions</button>
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
        </div>
      </header>

      <section className="board" aria-label="Trellis columns">
        {boardColumns.map((column) => {
          const tasks = state?.tasks.filter((task) => task.status === column.id) ?? [];
          const collapsed = hostMode === 'sidebar' && Boolean(collapsedLanes[column.id]);
          const qaWaiting = column.id === 'ready-for-qa';
          const laneTitle = qaWaiting ? 'QA Waiting' : column.title;
          return (
            <div
              className={`lane status-${column.id}${qaWaiting ? ' laneQaWaiting' : ''}${collapsed ? ' laneCollapsed' : ''}${collapsed && dropTarget === column.id ? ' laneDropTarget' : ''}`}
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
                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${laneTitle}`}
                    onClick={() => toggleLane(column.id)}
                  >
                    <span className="chevron" aria-hidden="true">
                      {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
                    </span>
                    <i className="laneDot" aria-hidden="true" />
                    <h2>{laneTitle}</h2>
                  </button>
                ) : (
                  <div>
                    <i className="laneDot" aria-hidden="true" />
                    <h2>{laneTitle}</h2>
                    <p>{qaWaiting ? 'Needs attention' : statusHints[column.id]}</p>
                  </div>
                )}
                <span className={`laneCount${tasks.length === 0 ? ' laneCountZero' : ''}`}>{tasks.length}</span>
              </div>
              {!collapsed && (
              <div className="cards">
                {tasks.map((task) => {
                  const activeRun = state?.activeRuns?.[task.id];
                  return (
                  <button
                    className={`card status-${task.status}`}
                    draggable
                    key={task.id}
                    onClick={() => setSelectedId(task.id)}
                    onDragStart={() => setDragId(task.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropTarget(null);
                    }}
                  >
                    <span className="cardTop">
                      <span className="idGroup">
                        <i className="statusDot" aria-hidden="true" />
                        <span className="cardId">{task.id}</span>
                      </span>
                      <span className={`prioGroup prio-${task.priority}`}>
                        <PriorityIcon level={task.priority} />
                        <span>{task.priority}</span>
                      </span>
                    </span>
                    <span className="cardTitle" title={task.title || 'Untitled task'}>{task.title || 'Untitled task'}</span>
                    <span className="cardBottom">
                      <span className="phaseTags">
                        {activeRun ? (
                          <span className={`phaseTag agent-${activeRun.agent}`}>
                            <b>{activeRun.phase === 'qa' ? 'QA' : 'Build'}</b>{activeRun.agent}
                          </span>
                        ) : (
                          <>
                            <span className={`phaseTag agent-${task.assignedAgent}`}><b>Build</b>{task.assignedAgent}</span>
                            <span className={`phaseTag agent-${task.qaAgent}`}><b>QA</b>{task.qaAgent}</span>
                          </>
                        )}
                      </span>
                      {workflowPercent[task.status] < 100 ? (
                        <span
                          className={`workflowProgress${state?.liveTerminals?.includes(task.id) || generatingIds.includes(task.id) ? ' workflowProgressLive' : ''}`}
                          title={`${workflowPercent[task.status]}% through the Trellis workflow`}
                          aria-label={`${workflowPercent[task.status]} percent workflow progress`}
                          style={{ '--workflow-progress': `${workflowPercent[task.status]}%` } as React.CSSProperties}
                        >
                          <i aria-hidden="true" />
                          <span>{workflowPercent[task.status]}%</span>
                        </span>
                      ) : (
                        <span className="screenReaderOnly">{statusLabels[task.status]} task, workflow complete</span>
                      )}
                    </span>
                  </button>
                  );
                })}
                {state?.tasks.length === 0 && column.id === boardColumns[0]?.id && (
                  <div className="laneStart">
                    <span>Start the workflow here</span>
                    <button className="primary" onClick={openCreate}>New task</button>
                  </div>
                )}
              </div>
              )}
            </div>
          );
        })}
      </section>

      </>
      )}

      {createOpen && !draft && (
        <section className="detailPage createPage" aria-label="Create task">
          <div className="detailNav">
            <div className="detailNavLeft">
              <button className="iconButton" aria-label="Back to board" title="Back to board" onClick={() => setCreateOpen(false)}>
                <ArrowLeftIcon />
              </button>
              <span className="navTitle">Create Task</span>
            </div>
          </div>
          <div className="createBody">
            <div className="createHero">
              <span className="heroTile"><LayoutGridIcon /></span>
              <h2>What would you like to build?</h2>
              <p>Create tasks, investigate bugs, or bulk generate from a PRD or bullet points.</p>
            </div>
            <div className="modeCards">
              {([
                { key: 'quick', icon: <SparklesIcon />, title: 'Quick Create', desc: 'Describe in a sentence, AI generates the full PRD and acceptance criteria.' },
                { key: 'prd', icon: <FileTextIcon />, title: 'Bulk Generate', desc: 'Paste a PRD or bullet-point requirements to create multiple actionable tasks.' },
                { key: 'bug', icon: <BugIcon />, title: 'Bug Investigation', desc: 'Describe a bug for AI to investigate the codebase and propose a fix.' }
              ] as const).map((mode) => (
                <button
                  key={mode.key}
                  className={`modeCard${createMode === mode.key ? ' modeCardSelected' : ''}`}
                  aria-pressed={createMode === mode.key}
                  onClick={() => setCreateMode(mode.key)}
                >
                  <span className="modeIcon">{mode.icon}</span>
                  <span className="modeTitle">{mode.title}</span>
                  <span className="modeDesc">{mode.desc}</span>
                </button>
              ))}
            </div>
          </div>
          <footer className="chatComposer" aria-label="Task composer">
            {createBusy === 'prd' && (
              <p className="chatStatus" role="status" aria-live="polite">
                <LoaderPinwheelIcon />
                Bulk generating tasks… You can go back — this continues in the background.
              </p>
            )}
            {pendingIntakes.length > 0 && (
              <div className="intakeQueue" aria-label="Recent task submissions" aria-live="polite">
                {pendingIntakes.map((item) => (
                  <button
                    type="button"
                    key={item.requestId}
                    className={`intakeQueueItem intake-${item.state}`}
                    disabled={!item.taskId}
                    title={item.message || item.summary}
                    onClick={() => item.taskId && setSelectedId(item.taskId)}
                  >
                    <span className="intakeQueueState">{item.state === 'done' ? 'Ready' : item.state === 'error' ? 'Error' : 'Drafting'}</span>
                    <span className="intakeQueueSummary">{item.summary}</span>
                  </button>
                ))}
              </div>
            )}
            {intakeNotice && <p className="intakeNotice" role="alert">{intakeNotice}</p>}
            {mentionQuery !== null && mentionMatches.length > 0 && (
              <>
                <div className="menuOverlay" onClick={() => setMentionQuery(null)} />
                <div className="mentionMenu" role="listbox" aria-label="Workspace files">
                  {mentionMatches.map((file) => (
                    <button key={file} role="option" aria-selected="false" onClick={() => insertMention(file)}>{file}</button>
                  ))}
                </div>
              </>
            )}
            {intakeFiles.length > 0 && (
              <div className="attachmentChips" aria-label="Selected attachments">
                {intakeFiles.map((file) => (
                  <span className="attachmentChip" key={file.key} title={file.path || file.name}>
                    <span>{file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      title={`Remove ${file.name}`}
                      onClick={() => setIntakeFiles((current) => current.filter((item) => item.key !== file.key))}
                    >
                      <XIcon />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              rows={1}
              className="chatInput"
              autoFocus
              placeholder={createMode === 'prd'
                ? 'Paste a PRD or bullet-point requirements… (Cmd+Enter creates tasks)'
                : createMode === 'bug'
                  ? 'Describe the bug (@mention for context)'
                  : 'Describe your task (@mention for context)'}
              value={createText}
              ref={autoGrow}
              onMouseDown={() => setMentionQuery(null)}
              onFocus={() => setMentionQuery(null)}
              onPaste={pasteIntoComposer}
              onChange={(event) => {
                autoGrow(event.target);
                setCreateText(event.target.value);
                const caret = event.target.selectionStart ?? event.target.value.length;
                const match = /(^|[\s(])@([\w./~-]*)$/.exec(event.target.value.slice(0, caret));
                setMentionQuery(match ? match[2] : null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setMentionQuery(null);
                  return;
                }
                if (event.key === 'Enter' && mentionQuery !== null && mentionMatches.length > 0) {
                  event.preventDefault();
                  insertMention(mentionMatches[0]);
                  return;
                }
                const sends = createMode === 'prd'
                  ? event.key === 'Enter' && (event.metaKey || event.ctrlKey)
                  : event.key === 'Enter' && !event.shiftKey;
                if (sends) {
                  event.preventDefault();
                  sendCreate();
                }
              }}
            />
            <div className="chatControls">
              <div className="chatLeft">
                <button
                  className="chatIconBtn"
                  aria-label="Attach image, Markdown, or text file"
                  title="Attach image, Markdown, or text file"
                  disabled={createMode === 'prd'}
                  onClick={() => vscode.postMessage({ type: 'select-intake-files' })}
                >
                  <PlusIcon />
                </button>
                <span className="agentSelect">
                  <span className="propDisplay" aria-hidden="true">
                    <b>Build</b>
                    <span>{createAgent}</span>
                    <span className="propChevron"><ChevronDownIcon /></span>
                  </span>
                  <select className="propSelect" aria-label="Build agent" value={createAgent} onChange={(event) => setCreateAgent(event.target.value as AssignedAgent)}>
                    <option value="claude">claude</option>
                    <option value="codex">codex</option>
                    <option value="unassigned">unassigned</option>
                  </select>
                </span>
                <span className="agentSelect">
                  <span className="propDisplay" aria-hidden="true">
                    <b>QA</b>
                    <span>{createQaAgent}</span>
                    <span className="propChevron"><ChevronDownIcon /></span>
                  </span>
                  <select className="propSelect" aria-label="QA agent" value={createQaAgent} onChange={(event) => setCreateQaAgent(event.target.value as AssignedAgent)}>
                    <option value="claude">claude</option>
                    <option value="codex">codex</option>
                    <option value="unassigned">unassigned</option>
                  </select>
                </span>
              </div>
              <button
                className="chatSend"
                aria-label={createMode === 'prd' ? 'Bulk generate tasks' : 'Create task'}
                title={createMode === 'prd' ? 'Bulk generate tasks' : 'Create task'}
                disabled={!createText.trim() || (createMode === 'prd' && (createBusy !== null || prdSplitting))}
                onClick={sendCreate}
              >
                <ArrowUpIcon />
              </button>
            </div>
          </footer>
        </section>
      )}

      {draft && (
        <section className="detailPage" aria-label="Task detail">
          <div className="detailNav">
            <div className="detailNavLeft">
              <button className="iconButton" aria-label="Back to board" title="Back to board" onClick={closeDraft}>
                <ArrowLeftIcon />
              </button>
              <span className="detailNavId">{transientDraftRef.current ? 'Unsaved draft' : draft.id}</span>
              <span className="saveHint">
                {saveState === 'saving' && 'saving…'}
                {saveState === 'saved' && 'saved'}
                {saveState === 'error' && 'save failed'}
              </span>
            </div>
            {!transientDraftRef.current && <div className="detailNavRight">
              <div className="menuWrap">
                <button className="iconButton" aria-label="More actions" title="More actions" onClick={() => setMenuOpen((open) => !open)}>
                  <EllipsisVerticalIcon />
                </button>
                {menuOpen && (
                  <>
                    <div className="menuOverlay" onClick={() => setMenuOpen(false)} />
                    <div className="menu" role="menu">
                      {state?.liveTerminals?.includes(draft.id) && (
                        <button role="menuitem" onClick={() => {
                          setMenuOpen(false);
                          vscode.postMessage({ type: 'show-terminal', id: draft.id });
                        }}>Show agent terminal</button>
                      )}
                      <button role="menuitem" onClick={() => {
                        setMenuOpen(false);
                        vscode.postMessage({ type: 'archive-task', id: draft.id });
                      }}>Archive task</button>
                      <button
                        role="menuitem"
                        className="menuDanger"
                        onClick={() => {
                          setMenuOpen(false);
                          setDeleteModalOpen(true);
                        }}
                      >
                        Delete task
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>}
          </div>

          <div className="detailBody">
          <textarea
            className="titleInput"
            placeholder="Untitled task"
            rows={1}
            value={draft.title}
            ref={autoGrow}
            onChange={(event) => {
              autoGrow(event.target);
              updateDraft({ ...draft, title: event.target.value });
            }}
          />

          <div className="props">
            <label className="propRow">
              <span>Status</span>
              <span className={`propValue status-${draft.status}`}>
                <span className="propDisplay" aria-hidden="true">
                  <i className="statusDot" />
                  <span>{statusLabels[draft.status]}</span>
                  <span className="propChevron"><ChevronDownIcon /></span>
                </span>
                <select
                  className="propSelect"
                  aria-label="Status"
                  disabled={transientDraftRef.current}
                  value={draft.status}
                  onChange={(event) => {
                    const status = event.target.value as TaskStatus;
                    if (transientDraftRef.current) {
                      saveDraftNow({ ...draft, status });
                    } else {
                      setDraft({ ...draft, status });
                      vscode.postMessage({ type: 'move-task', id: draft.id, status, expectedLastUpdated: lastKnownUpdatedRef.current });
                    }
                  }}
                >
                  {(Object.keys(statusLabels) as TaskStatus[]).filter((status) => status !== 'human-review').map((status) => (
                    <option key={status} value={status}>{statusLabels[status]}</option>
                  ))}
                </select>
              </span>
            </label>
            <label className="propRow">
              <span>Priority</span>
              <span className="propValue">
                <span className={`propDisplay prio-${draft.priority}`} aria-hidden="true">
                  <PriorityIcon level={draft.priority} />
                  <span>{draft.priority[0].toUpperCase() + draft.priority.slice(1)}</span>
                  <span className="propChevron"><ChevronDownIcon /></span>
                </span>
                <select className="propSelect" aria-label="Priority" value={draft.priority} onChange={(event) => saveDraftNow({ ...draft, priority: event.target.value as Priority })}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </span>
            </label>
            <label className="propRow">
              <span>Agent</span>
              <span className="propValue">
                <span className="propDisplay" aria-hidden="true">
                  <span>{draft.assignedAgent}</span>
                  <span className="propChevron"><ChevronDownIcon /></span>
                </span>
                <select className="propSelect" aria-label="Agent" value={draft.assignedAgent} onChange={(event) => saveDraftNow({ ...draft, assignedAgent: event.target.value as AssignedAgent })}>
                  <option value="unassigned">unassigned</option>
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                </select>
              </span>
            </label>
            <label className="propRow">
              <span>QA</span>
              <span className="propValue">
                <span className="propDisplay" aria-hidden="true">
                  <span>{draft.qaAgent}</span>
                  <span className="propChevron"><ChevronDownIcon /></span>
                </span>
                <select className="propSelect" aria-label="QA agent" value={draft.qaAgent} onChange={(event) => saveDraftNow({ ...draft, qaAgent: event.target.value as AssignedAgent })}>
                  <option value="unassigned">unassigned</option>
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                </select>
              </span>
            </label>
          </div>

          {!transientDraftRef.current && <div className="actions">
            {draft.status === 'backlog' && (
              <Action
                label={generatingIds.includes(draft.id) ? 'Drafting PRD…' : draft.description.trim() ? 'Regenerate PRD' : 'Generate PRD'}
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
            {draft.status === 'ready-for-qa' && (
              <Action label="QA is starting automatically…" onClick={() => undefined} disabled />
            )}
            {draft.status === 'failed-qa' && <p className="automationHint">Add context below while this task waits to return to Building.</p>}
            {state?.activeRuns?.[draft.id] && (() => {
              const run = state.activeRuns[draft.id];
              const isTerminal = run.surface === 'terminal';
              const hasLiveTerminal = isTerminal && state.liveTerminals.includes(draft.id);
              const awaitingChatQa = run.surface === 'chat' && draft.status === 'ready-for-qa';
              return (
              <div className="terminalBanner" role="status">
                {!awaitingChatQa && <span className="terminalBannerSpin" aria-hidden="true" />}
                <span className="terminalBannerText">
                  {awaitingChatQa
                    ? `Build finished in ${run.agent} chat. QA is reserved for that chat; no terminal will start.`
                    : `${run.agent} is running ${run.phase === 'qa' ? 'QA' : 'Build'} in ${isTerminal ? 'a Trellis terminal' : 'chat'}. Another session will not be started.`}
                </span>
                {hasLiveTerminal && <button className="ghost" onClick={() => vscode.postMessage({ type: 'show-terminal', id: draft.id })}>Show terminal</button>}
              </div>
              );
            })()}
            {(draft.status === 'done' || draft.status === 'human-review') && (
              <Action label={draft.workflowMode === 'direct-on-main' ? 'Mark complete' : 'Ship (PR / merge)'} onClick={() => vscode.postMessage({ type: 'ship-task', id: draft.id, expectedLastUpdated: lastKnownUpdatedRef.current })} primary />
            )}
          </div>}

          {generatingIds.includes(draft.id) && (
            <p className="draftingNote">Drafting title, PRD, and checklists from the brief…</p>
          )}

          <div className="fields">
            <section className="fieldSection">
              <button className="fieldToggle" aria-expanded={prdOpen} onClick={() => setPrdOpen((open) => !open)}>
                <span className="chevron" aria-hidden="true">{prdOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}</span>
                PRD Description
              </button>
              {prdOpen && (
                <RichTextEditor
                  ariaLabel="PRD description"
                  html={draft.descriptionRichText}
                  fallbackText={draft.description}
                  onChange={(html, text) => updateDraft({ ...draft, descriptionRichText: html, description: text })}
                />
              )}
            </section>
            <section className="fieldSection">
              <button className="fieldToggle" aria-expanded={acOpen} onClick={() => setAcOpen((open) => !open)}>
                <span className="chevron" aria-hidden="true">{acOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}</span>
                Acceptance Criteria
              </button>
              {acOpen && (
                <RichTextEditor
                  ariaLabel="Acceptance criteria"
                  html={draft.acceptanceCriteriaRichText}
                  fallbackText={(draft.acceptanceCriteria ?? []).join('\n')}
                  onChange={(html, text, items) => updateDraft({
                    ...draft,
                    acceptanceCriteriaRichText: html,
                    acceptanceCriteria: items.length ? items : splitLines(text)
                  })}
                />
              )}
            </section>
          </div>

          <button className="sectionToggle" onClick={() => setDetailsOpen((open) => !open)}>
            <span className="chevron" aria-hidden="true">
              {detailsOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
            </span>
            Other details
          </button>
          {detailsOpen && (
            <div className="detailSections">
              {(draft.lastValidation || draft.shipResult) && (
                <div className="statusPanel">
                  {draft.lastValidation && (() => {
                    const total = draft.lastValidation.results.length;
                    const failed = draft.lastValidation.results.filter((result) => result.exitCode !== 0).length;
                    const noun = total === 1 ? 'check' : 'checks';
                    return (
                      <p className={draft.lastValidation.passed ? 'statusOk' : 'statusBad'}>
                        {draft.lastValidation.passed
                          ? `All ${total} validation ${noun} passed before QA`
                          : `${failed} of ${total} validation ${noun} failed`}
                        {' · '}{formatTimelineTime(draft.lastValidation.ranAt)}
                      </p>
                    );
                  })()}
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
              {hasTaskDetails(draft) ? (
                <>
                  <DetailList label="QA Checklist" items={draft.qaChecklist} />
                  <DetailList label="Design QA Checklist" items={draft.designQaChecklist} />
                  <DetailList label="Validation Commands" items={draft.validationCommands} />
                  <DetailList label="Relevant Files" items={draft.relevantFiles} />
                  <DetailList label="Constraints" items={draft.constraints} />
                  <DetailText label="Agent Notes" text={draft.agentNotes} />
                  <DetailList label="QA Evidence" items={draft.qaEvidence} />
                  <DetailText label="Branch" text={draft.branchName} />
                </>
              ) : (
                !draft.lastValidation && !draft.shipResult && (
                  <p className="detailEmpty">Checklists, files, and notes filled in by agents will appear here.</p>
                )
              )}
            </div>
          )}

          <ThreadSection
            comments={draft.comments ?? []}
            activity={[...(draft.activityLog ?? []), ...(draft.qaNotes ?? [])]}
            tab={detailTab}
            onTab={setDetailTab}
            canComment={draft.status === 'human-review' || draft.status === 'failed-qa'}
            agentAssigned={draft.assignedAgent !== 'unassigned'}
            note={reviewFeedback}
            onNote={setReviewFeedback}
            submitting={reviewSubmitting}
            onSend={() => {
              setReviewSubmitting(true);
              vscode.postMessage({
                type: 'request-changes',
                id: draft.id,
                feedback: reviewFeedback,
                expectedLastUpdated: lastKnownUpdatedRef.current
              });
            }}
          />
          </div>
          {deleteModalOpen && (
            <div className="modalOverlay" onClick={() => setDeleteModalOpen(false)}>
              <div className="modal" role="alertdialog" aria-modal="true" aria-label={`Delete ${draft.id}`} onClick={(event) => event.stopPropagation()}>
                <h3>Delete {draft.id}?</h3>
                <p>This permanently removes the task and its worktree. It cannot be undone.</p>
                <div className="modalActions">
                  <button className="ghost" onClick={() => setDeleteModalOpen(false)}>Cancel</button>
                  <button className="danger" autoFocus onClick={() => vscode.postMessage({ type: 'delete-task', id: draft.id })}>Delete task</button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {projectDraft && !draft && (
        <>
          {hostMode === 'panel' && <div className="drawerScrim" onClick={closeProject} />}
          <section className="detailPage projectPage" aria-label="Project context">
          <div className="detailNav">
            <div className="detailNavLeft">
              <button
                className="iconButton"
                aria-label={hostMode === 'panel' ? 'Close' : 'Back to board'}
                title={hostMode === 'panel' ? 'Close' : 'Back to board'}
                onClick={closeProject}
              >
                {hostMode === 'panel' ? <XIcon /> : <ArrowLeftIcon />}
              </button>
              <span className="navTitle">Project Context</span>
            </div>
            {projectOnboarding && (
              <div className="detailNavRight">
                <button className="ghost" onClick={closeProject}>Skip for now</button>
              </div>
            )}
          </div>

          <div className="detailBody">
          <div className="contextActions">
            <button
              className="primary"
              disabled={inferBusy}
              onClick={() => {
                if (projectSaveTimer.current !== undefined) {
                  window.clearTimeout(projectSaveTimer.current);
                  projectSaveTimer.current = undefined;
                }
                const pendingDraft = projectDirty.current ? projectDraftRef.current : undefined;
                if (pendingDraft) {
                  projectSentVersion.current = projectEditVersion.current;
                  projectDirty.current = false;
                }
                setInferBusy(true);
                vscode.postMessage({ type: 'infer-project', project: pendingDraft });
              }}
            >
              {inferBusy ? 'Scanning repo…' : 'Infer from repo'}
            </button>
            <p className={`autosaveStatus ${projectSaveState}`} role="status" aria-live="polite">
              {projectSaveState === 'saving' && 'Saving changes…'}
              {projectSaveState === 'saved' && 'Saved automatically'}
              {projectSaveState === 'error' && 'Could not save — your edits are still here'}
              {projectSaveState === 'idle' && `Autosaved · ${new Date(projectDraft.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
            </p>
          </div>

          <div className="contextBlock">
            <WorkflowModePicker
              value={projectDraft.workflowMode ?? 'branch-per-task'}
              onChange={(workflowMode) => updateProject({ ...projectDraft, workflowMode })}
            />
            <p className="fieldHint">Changes apply to new task claims. Existing tasks stay where they started.</p>
          </div>

          <div className="contextIntro">
            <p>Give every agent the same product and repository context. Start with a repo scan, add your own notes, or come back from the menu whenever you need it.</p>
          </div>

          <div className="fields contextFields">
            <div>
              <Field
                label="Project context"
                placeholder="Product overview, architecture, conventions, constraints, links…"
                value={projectDraft.contextNotes ?? ''}
                onChange={(value) => updateProject({ ...projectDraft, contextNotes: value })}
              />
              <p className="fieldHint">Shared with agents during PRD generation. Stored in .trellis/project.json.</p>
            </div>

            <div>
              <ListField label="Validation commands" value={projectDraft.validationCommands} onChange={(value) => updateProject({ ...projectDraft, validationCommands: splitLines(value) })} />
              <p className="fieldHint">Used by QA runs, one per line.</p>
            </div>
          </div>

          {projectDraft.inference?.lastInferred && (
            <div className="detailSections repoScan">
              <h4 className="repoScanTitle">Repo scan · {timeAgo(projectDraft.inference.lastInferred)}</h4>
              {(projectDraft.inference.projectName || projectDraft.inference.projectDescription) && (
                <DetailText
                  label="Project"
                  text={[projectDraft.inference.projectName, projectDraft.inference.projectDescription].filter(Boolean).join(' — ')}
                />
              )}
              <DetailText label="README" text={projectDraft.inference.readmeSummary ?? ''} />
              <DetailText label="Stack" text={projectDraft.inference.likelyStack.join(', ')} />
              <DetailText label="Package manager" text={projectDraft.inference.packageManager} />
              <DetailText label="Layout" text={(projectDraft.inference.topLevelDirs ?? []).map((dir) => `${dir}/`).join(', ')} />
              <DetailText label="Key files" text={projectDraft.inference.detectedFiles.join(', ')} />
              <DetailList label="Suggested validation" items={projectDraft.inference.suggestedValidation} />
            </div>
          )}

          </div>
          </section>
        </>
      )}
    </main>
  );
}

function RichTextEditor({
  ariaLabel,
  html,
  fallbackText,
  onChange
}: {
  ariaLabel: string;
  html?: string;
  fallbackText: string;
  onChange: (html: string, text: string, items: string[]) => void;
}): JSX.Element {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const rendered = html ? sanitizeRichHtml(html) : textToRichHtml(fallbackText);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && document.activeElement !== editor && editor.innerHTML !== rendered) {
      editor.innerHTML = rendered;
    }
  }, [rendered]);

  const emit = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const normalizedHtml = editor.innerHTML === '<br>' ? '' : editor.innerHTML;
    const text = editor.innerText.replace(/\u00a0/g, ' ').trim();
    const blocks = Array.from(editor.querySelectorAll('li, p, div'))
      .filter((node) => node.tagName === 'LI' || (node.tagName !== 'DIV' || node.children.length === 0))
      .filter((node) => !node.closest('li') || node.tagName === 'LI')
      .map((node) => (node.textContent ?? '').trim())
      .filter(Boolean);
    onChange(normalizedHtml, text, blocks);
  };

  const run = (command: 'formatBlock' | 'insertUnorderedList' | 'insertOrderedList', value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    emit();
  };

  return (
    <div className="richEditor">
      <div
        ref={editorRef}
        className="richEditorSurface"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        data-placeholder={`Add ${ariaLabel.toLowerCase()}…`}
        onInput={emit}
        onBlur={emit}
        onKeyDown={(event) => {
          const primaryModifier = event.metaKey || event.ctrlKey;
          if (!primaryModifier) return;

          if (event.shiftKey && !event.altKey && (event.code === 'Digit7' || event.key === '7')) {
            event.preventDefault();
            run('insertOrderedList');
          } else if (event.shiftKey && !event.altKey && (event.code === 'Digit8' || event.key === '8')) {
            event.preventDefault();
            run('insertUnorderedList');
          } else if (event.altKey && !event.shiftKey && (event.code === 'Digit0' || event.key === '0')) {
            event.preventDefault();
            run('formatBlock', 'p');
          }
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData('text/plain');
          if (text) {
            event.preventDefault();
            document.execCommand('insertText', false, text);
          }
        }}
      />
    </div>
  );
}

function WorkflowModePicker({ value, onChange, setup = false }: { value: WorkflowMode; onChange: (mode: WorkflowMode) => void; setup?: boolean }): JSX.Element {
  return (
    <fieldset className={`workflowPicker ${setup ? 'workflowPickerSetup' : ''}`}>
      <legend>{setup ? 'Where should agents work?' : 'Agent workspace'}</legend>
      <div className="workflowOptions">
        <button type="button" className={`workflowOption ${value === 'branch-per-task' ? 'selected' : ''}`} aria-pressed={value === 'branch-per-task'} onClick={() => onChange('branch-per-task')}>
          <span className="workflowOptionTop"><strong>Safer workspace</strong><span className="recommendedBadge">Recommended</span></span>
          <span>Each task gets its own protected workspace. Best for parallel agents and easy review.</span>
        </button>
        <button type="button" className={`workflowOption ${value === 'direct-on-main' ? 'selected' : ''}`} aria-pressed={value === 'direct-on-main'} onClick={() => onChange('direct-on-main')}>
          <span className="workflowOptionTop"><strong>Work on this folder</strong></span>
          <span>Simpler setup. One agent at a time changes the project you already have open.</span>
        </button>
      </div>
    </fieldset>
  );
}

function textToRichHtml(value: string): string {
  return String(value ?? '').split(/\n{2,}|\n/).filter(Boolean).map((line) => `<p>${escapeHtml(line)}</p>`).join('');
}

function sanitizeRichHtml(value: string): string {
  const documentValue = new DOMParser().parseFromString(value, 'text/html');
  const allowed = new Set(['P', 'DIV', 'BR', 'UL', 'OL', 'LI']);
  for (const element of Array.from(documentValue.body.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name);
    if (!allowed.has(element.tagName)) element.replaceWith(...Array.from(element.childNodes));
  }
  return documentValue.body.innerHTML;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] ?? character);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function extensionForMediaType(mediaType: string): string {
  return ({ 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[mediaType] ?? 'png';
}

function mediaTypeForFileName(name: string): string {
  if (/\.md$/i.test(name)) return 'text/markdown';
  if (/\.txt$/i.test(name)) return 'text/plain';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.gif$/i.test(name)) return 'image/gif';
  if (/\.webp$/i.test(name)) return 'image/webp';
  return 'image/png';
}

// Sizes a textarea to its content so the detail title wraps like the design
// instead of truncating; used as both ref callback and onChange helper.
function autoGrow(el: HTMLTextAreaElement | null): void {
  if (!el) {
    return;
  }
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function Action({ label, onClick, primary = false, disabled = false, title }: { label: string; onClick: () => void; primary?: boolean; disabled?: boolean; title?: string }): JSX.Element {
  return <button className={`action ${primary ? 'actionPrimary' : ''}`} disabled={disabled} title={title} onClick={onClick}>{label}</button>;
}

function Field({ label, value, onChange, placeholder, big = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; big?: boolean }): JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  // Re-fit on external value changes too (e.g. "Infer from repo" seeding notes).
  useEffect(() => {
    autoGrow(areaRef.current);
  }, [value]);
  return (
    <label>
      <span>{label}</span>
      <textarea
        className={big ? 'bigInput' : undefined}
        placeholder={placeholder}
        value={value}
        ref={areaRef}
        onChange={(event) => {
          autoGrow(event.target);
          onChange(event.target.value);
        }}
      />
    </label>
  );
}

function ListField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string) => void }): JSX.Element {
  return <Field label={label} value={(value ?? []).join('\n')} onChange={onChange} />;
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

// Relative times like the design ("45m ago", "2h ago"); falls back to a
// short date once entries are older than a week.
function timeAgo(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  if (seconds < 604800) {
    return `${Math.floor(seconds / 86400)}d ago`;
  }
  return formatTimelineTime(timestamp);
}

function formatTimelineTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ThreadSection({
  comments,
  activity,
  tab,
  onTab,
  canComment,
  agentAssigned,
  note,
  onNote,
  submitting,
  onSend
}: {
  comments: TaskComment[];
  activity: ActivityEntry[];
  tab: 'comments' | 'activity';
  onTab: (tab: 'comments' | 'activity') => void;
  canComment: boolean;
  agentAssigned: boolean;
  note: string;
  onNote: (value: string) => void;
  submitting: boolean;
  onSend: () => void;
}): JSX.Element {
  const sortedActivity = activity.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const ordered = comments.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const sendDisabled = !note.trim() || submitting || !agentAssigned;
  return (
    <section className="threadSection" aria-label="Comments and activity">
      <div className="tabBar" role="tablist">
        <button role="tab" aria-selected={tab === 'comments'} className={`tab${tab === 'comments' ? ' tabActive' : ''}`} onClick={() => onTab('comments')}>
          Comments ({comments.length})
        </button>
        <button role="tab" aria-selected={tab === 'activity'} className={`tab${tab === 'activity' ? ' tabActive' : ''}`} onClick={() => onTab('activity')}>
          Activity
        </button>
      </div>
      {tab === 'comments' ? (
        <div className="commentThread">
          {ordered.length === 0 && <p className="threadEmpty">No comments yet.</p>}
          {ordered.map((comment) => {
            const isAgent = comment.author === 'claude' || comment.author === 'codex';
            return (
              <article className="messageNote" key={comment.id}>
                <span className="messageIcon">{isAgent ? <AtSignIcon /> : <BookmarkIcon />}</span>
                <div className="messageContent">
                  <p>{isAgent && <><strong className="mention">@{comment.author}</strong>{' '}</>}{comment.message}</p>
                  <time>{timeAgo(comment.createdAt)}</time>
                </div>
              </article>
            );
          })}
          {canComment && (
            <div className="inlineCommentInput">
              <div className="inputRow">
                <textarea
                  className="noteInput"
                  rows={1}
                  value={note}
                  onChange={(event) => onNote(event.target.value)}
                  placeholder="Write a note…"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !sendDisabled) {
                      event.preventDefault();
                      onSend();
                    }
                  }}
                />
                <button
                  className="sendBtn"
                  aria-label="Comment and send to Building"
                  disabled={sendDisabled}
                  title={!agentAssigned ? 'Assign a build agent before requesting changes.' : 'Sends the note to the build agent and returns the task to Building.'}
                  onClick={onSend}
                >
                  <ArrowUpIcon />
                </button>
              </div>
              {submitting && <p className="threadCaption">Sending…</p>}
            </div>
          )}
        </div>
      ) : (
        <div className="activityThread">
          {sortedActivity.length === 0 && <p className="threadEmpty">No activity yet.</p>}
          {sortedActivity.map((entry, index) => (
            <div className="timelineRow" key={`${entry.timestamp}-${index}`}>
              <time>{timeAgo(entry.timestamp)}</time>
              <span className="timelineActor">{entry.actor}</span>
              <span className="timelineMessage">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function splitLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function blankDraft(): Task {
  return {
    id: '',
    title: '',
    status: 'backlog',
    priority: 'medium',
    assignedAgent: 'unassigned',
    qaAgent: 'unassigned',
    brief: '',
    description: '',
    acceptanceCriteria: [],
    qaChecklist: [],
    designQaChecklist: [],
    validationCommands: [],
    relevantFiles: [],
    constraints: [],
    agentNotes: '',
    qaNotes: [],
    qaEvidence: [],
    activityLog: [],
    comments: [],
    claimedBy: '',
    qaClaimedBy: '',
    branchName: '',
    worktreePath: '',
    claimedAt: '',
    lastValidation: null,
    shipResult: null,
    lastUpdated: ''
  };
}

function isMeaningfulBlankDraft(task: Task): boolean {
  const textFields = [task.title, task.brief, task.description, task.agentNotes];
  const listFields = [
    task.acceptanceCriteria,
    task.qaChecklist,
    task.designQaChecklist,
    task.validationCommands,
    task.relevantFiles,
    task.constraints
  ];
  return textFields.some((value) => value.trim().length > 0)
    || listFields.some((items) => items.some((value) => value.trim().length > 0))
    || task.priority !== 'medium'
    || task.assignedAgent !== 'unassigned'
    || task.qaAgent !== 'unassigned';
}

function cloneTask(task: Task): Task {
  return JSON.parse(JSON.stringify(task)) as Task;
}

function cloneProject(project: ProjectContext): ProjectContext {
  return JSON.parse(JSON.stringify(project)) as ProjectContext;
}

createRoot(document.getElementById('root')!).render(<App />);
