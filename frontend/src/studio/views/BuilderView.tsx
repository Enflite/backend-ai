/**
 * studio/views/BuilderView.tsx — the visual automation builder canvas.
 *
 * Vertical step canvas: the trigger card first, then step cards joined by
 * hairline connectors with "+" insert affordances between them. Top bar
 * carries the AUTOMATIONS / <NAME> breadcrumb, editable title, status pill,
 * and Explain / Test / Save / Deploy. A side editor panel edits the selected
 * trigger or step; action-step inputs are driven by the catalog entry's real
 * params JSON Schema. The Explain panel renders a deterministic,
 * definition-derived tour of the automation; the add-step menu offers
 * catalog-grounded AI suggestions.
 *
 * Honesty rules: test results render only from the real API (dry-run or
 * per-step live test); drafts persist through the real automations
 * endpoints.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../auth';
import { hasAnyPermission } from '../../shell/navRegistry';
import { Badge, Button, Skeleton } from '../../components/ui/primitives';
import ErrorState from '../../components/ui/ErrorState';
import {
  createStudioAutomation,
  deployStudioAutomation,
  getStudioAutomation,
  isStudioUnavailable,
  listStudioActions,
  listStudioConnections,
  saveStudioAutomation,
  suggestStudioAutomationSteps,
  testStudioAction,
  testStudioAutomation,
  undeployStudioAutomation,
} from '../api';
import type {
  StudioAction,
  StudioAutomation,
  StudioConnection,
  StudioStep,
  StudioStepKind,
  StudioStepTestResult,
  StudioTrigger,
} from '../types';
import {
  STUDIO_MANAGE_PERMISSIONS,
  STUDIO_RUN_PERMISSIONS,
} from '../types';
import {
  actionTestToStepResult,
  createStep,
  destructiveSteps,
  moveStep,
  newStepId,
  removeStep,
} from '../builder';
import StepCard from '../components/StepCard';
import TriggerCard from '../components/TriggerCard';
import AddStepMenu, { type AiSuggestionState } from '../components/AddStepMenu';
import StepEditorPanel, { type EditorSelection } from '../components/StepEditorPanel';
import DeployConfirmModal from '../components/DeployConfirmModal';
import ExplainPanel from '../components/ExplainPanel';
import { IconAlert, IconPlus } from '../components/StudioIcons';

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error' | 'notfound';

function newLocalDraft(): StudioAutomation {
  return {
    id: 'new',
    name: 'untitled-automation',
    title: 'Untitled automation',
    status: 'draft',
    triggerKind: 'manual',
    updatedAt: new Date().toISOString(),
    lastRunAt: null,
    description: '',
    trigger: { kind: 'manual' },
    steps: [],
    deployment: null,
  };
}

function statusBadgeTone(status: string): 'gray' | 'green' | 'red' | 'amber' {
  const s = status.toLowerCase();
  if (s === 'failed') return 'red';
  if (s === 'draft') return 'gray';
  if (s === 'scheduled') return 'amber';
  return 'green';
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

export default function BuilderView({ mode }: { mode: 'edit' | 'new' }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const permissions = user?.permissions ?? [];
  const canManage = hasAnyPermission(permissions, STUDIO_MANAGE_PERMISSIONS);
  const canTest = hasAnyPermission(permissions, STUDIO_RUN_PERMISSIONS);

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [automation, setAutomation] = useState<StudioAutomation | null>(null);
  const [catalog, setCatalog] = useState<StudioAction[]>([]);
  const [connections, setConnections] = useState<StudioConnection[]>([]);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<'trigger' | string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const [results, setResults] = useState<Map<string, StudioStepTestResult> | null>(null);
  const [openResults, setOpenResults] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState(false);
  const [stepTestBusy, setStepTestBusy] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployConfirmOpen, setDeployConfirmOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);

  const [addMenu, setAddMenu] = useState<{ index: number; anchor: DOMRect } | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestionState>({
    suggestions: null,
    loading: false,
    error: null,
  });
  const [copiedWebhook, setCopiedWebhook] = useState(false);
  const copyTimer = useRef<number | null>(null);

  const catalogById = useMemo(() => new Map(catalog.map((a) => [a.id, a])), [catalog]);
  const destructive = useMemo(
    () => (automation ? destructiveSteps(automation.steps, catalogById) : []),
    [automation, catalogById],
  );
  const deployed = automation?.deployment?.deployed === true;

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    setBanner(null);

    // Catalog + connections are live from Wave 1; degrade honestly on 404.
    const [catalogRes, connectionsRes] = await Promise.allSettled([
      listStudioActions(),
      listStudioConnections(),
    ]);
    if (catalogRes.status === 'fulfilled') {
      setCatalog(catalogRes.value);
    } else if (isStudioUnavailable(catalogRes.reason)) {
      setCatalog([]);
      setCatalogNote('The action catalog API is not available yet — action steps cannot be added.');
    } else {
      setCatalog([]);
      setCatalogNote('Could not load the action catalog.');
    }
    if (connectionsRes.status === 'fulfilled') {
      setConnections(connectionsRes.value);
    } else if (!isStudioUnavailable(connectionsRes.reason)) {
      setBanner('Could not load connections — per-step testing may not work.');
    }

    if (mode === 'new') {
      setAutomation(newLocalDraft());
      setLoadState('ready');
      return;
    }

    // Edit mode: load the automation from the real API.
    try {
      const detail = await getStudioAutomation(id ?? '');
      setAutomation(detail);
      setLoadState('ready');
    } catch (cause) {
      if (isStudioUnavailable(cause)) {
        // A 404 here means the automation doesn't exist (the API itself is up).
        setLoadState('notfound');
      } else {
        setLoadState('error');
        setLoadError(cause instanceof Error ? cause.message : 'Could not load the automation.');
      }
    }
  }, [id, mode]);

  useEffect(() => {
    void load();
    return () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, [load]);

  /* ---------------- AI suggestions ---------------- */

  // Load catalog-grounded suggestions whenever the add-step menu opens on a
  // saved draft. Suggestions are returned only — inserting one is explicit.
  const suggestionAutomationId = mode === 'new' ? 'new' : automation?.id ?? 'new';
  useEffect(() => {
    if (!addMenu || suggestionAutomationId === 'new') {
      setAiSuggestions({ suggestions: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setAiSuggestions({ suggestions: null, loading: true, error: null });
    void suggestStudioAutomationSteps(suggestionAutomationId)
      .then((suggestions) => {
        if (!cancelled) setAiSuggestions({ suggestions, loading: false, error: null });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setAiSuggestions({
            suggestions: null,
            loading: false,
            error: cause instanceof Error ? cause.message : 'Could not load suggestions.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [addMenu, suggestionAutomationId]);

  /** Apply a draft edit: marks dirty and clears stale test results. */
  const updateDraft = useCallback((fn: (draft: StudioAutomation) => StudioAutomation) => {
    setAutomation((prev) => (prev ? fn(prev) : prev));
    setDirty(true);
    setResults(null);
    setOpenResults(new Set());
  }, []);

  const selection: EditorSelection = useMemo(() => {
    if (!automation || !selectedId || !canManage) return null;
    if (selectedId === 'trigger') return { type: 'trigger', trigger: automation.trigger };
    const step = automation.steps.find((s) => s.id === selectedId);
    return step ? { type: 'step', step } : null;
  }, [automation, selectedId, canManage]);

  const clearSelectionOnEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAddMenu(null);
        setSelectedId(null);
      }
    },
    [],
  );
  useEffect(() => {
    document.addEventListener('keydown', clearSelectionOnEscape);
    return () => document.removeEventListener('keydown', clearSelectionOnEscape);
  }, [clearSelectionOnEscape]);

  /* ---------------- step ops ---------------- */

  const addStep = useCallback(
    (index: number, kind: StudioStepKind, actionId?: string) => {
      const step = createStep(kind, actionId);
      if (!step.connectionId && connections.length > 0) step.connectionId = connections[0].id;
      updateDraft((draft) => {
        const steps = [...draft.steps];
        steps.splice(index, 0, step);
        return { ...draft, steps };
      });
      setSelectedId(step.id);
      setAddMenu(null);
    },
    [connections, updateDraft],
  );

  const patchStep = useCallback(
    (stepId: string, patch: Partial<StudioStep>) => {
      updateDraft((draft) => ({
        ...draft,
        steps: draft.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
      }));
    },
    [updateDraft],
  );

  const handleMove = useCallback(
    (stepId: string, dir: -1 | 1) => {
      updateDraft((draft) => ({ ...draft, steps: moveStep(draft.steps, stepId, dir) }));
    },
    [updateDraft],
  );

  const handleDuplicate = useCallback(
    (stepId: string) => {
      const copyId = newStepId();
      updateDraft((draft) => {
        const index = draft.steps.findIndex((s) => s.id === stepId);
        if (index < 0) return draft;
        const original = draft.steps[index];
        const copy: StudioStep = {
          ...original,
          id: copyId,
          params: original.params ? { ...original.params } : undefined,
          name: original.name ? `${original.name} (copy)` : undefined,
        };
        const steps = [...draft.steps];
        steps.splice(index + 1, 0, copy);
        return { ...draft, steps };
      });
      setSelectedId(copyId);
    },
    [updateDraft],
  );

  const handleDelete = useCallback(
    (stepId: string) => {
      updateDraft((draft) => ({ ...draft, steps: removeStep(draft.steps, stepId) }));
      setSelectedId((prev) => (prev === stepId ? null : prev));
    },
    [updateDraft],
  );

  const insertSuggestedStep = useCallback(
    (index: number, step: StudioStep) => {
      if (!automation) return;
      const ids = new Set(automation.steps.map((s) => s.id));
      const finalStep: StudioStep = ids.has(step.id) ? { ...step, id: newStepId() } : step;
      if (!finalStep.connectionId && connections.length > 0) {
        finalStep.connectionId = connections[0].id;
      }
      updateDraft((draft) => {
        const steps = [...draft.steps];
        steps.splice(index, 0, finalStep);
        return { ...draft, steps };
      });
      setSelectedId(finalStep.id);
      setAddMenu(null);
    },
    [automation, connections, updateDraft],
  );

  /* ---------------- persistence ---------------- */

  /** Backend-unique name for a fresh draft, derived from the title. */
  const draftNameFor = useCallback((title: string) => {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return slug || 'untitled-automation';
  }, []);

  const handleSave = useCallback(async () => {
    if (!automation || !canManage || saving) return;
    setSaving(true);
    setBanner(null);
    try {
      if (mode === 'new' || automation.id === 'new') {
        // First save creates the automation, then moves to its edit route.
        let name = draftNameFor(automation.title);
        let created: StudioAutomation | null = null;
        for (let attempt = 0; attempt < 3 && !created; attempt++) {
          try {
            created = await createStudioAutomation({
              name,
              title: automation.title,
              description: automation.description,
              trigger: automation.trigger,
              steps: automation.steps,
            });
          } catch (cause) {
            const code = (cause as { code?: string })?.code;
            if (code === 'STUDIO_AUTOMATION_NAME_TAKEN' && attempt < 2) {
              name = `${draftNameFor(automation.title)}-${Math.random().toString(36).slice(2, 6)}`;
              continue;
            }
            throw cause;
          }
        }
        if (created) navigate(`/studio/automations/${created.id}`, { replace: true });
        return;
      }
      const saved = await saveStudioAutomation(automation.id, {
        name: automation.name,
        title: automation.title,
        description: automation.description,
        trigger: automation.trigger,
        steps: automation.steps,
      });
      setAutomation(saved);
      setDirty(false);
    } catch (cause) {
      setBanner(cause instanceof Error ? `Save failed: ${cause.message}` : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }, [automation, canManage, mode, saving, draftNameFor, navigate]);

  /* ---------------- test ---------------- */

  const handleTest = useCallback(async () => {
    if (!automation || !canTest || testing) return;
    if (mode === 'new' || automation.id === 'new') {
      setBanner('Save the automation first — dry-run needs a saved draft.');
      return;
    }
    setTesting(true);
    setBanner(null);
    try {
      const list = await testStudioAutomation(automation.id);
      setResults(new Map(list.map((r) => [r.stepId, r])));
      setOpenResults(new Set(list.filter((r) => r.status !== 'ok').map((r) => r.stepId)));
    } catch (cause) {
      setBanner(cause instanceof Error ? `Test failed: ${cause.message}` : 'Test failed.');
    } finally {
      setTesting(false);
    }
  }, [automation, canTest, mode, testing]);

  /** Per-step test for action steps — hits the live /studio/actions/test endpoint. */
  const handleTestStep = useCallback(
    async (step: StudioStep) => {
      if (!step.actionId || stepTestBusy) return;
      const connectionId = step.connectionId ?? connections[0]?.id;
      if (!connectionId) {
        setBanner('Pick a connection in the editor panel before testing this step.');
        return;
      }
      setStepTestBusy(step.id);
      try {
        const result = await testStudioAction(connectionId, step.actionId, step.params ?? {});
        const mapped = actionTestToStepResult(step.id, result);
        setResults((prev) => new Map(prev ?? []).set(step.id, mapped));
        setOpenResults((prev) => {
          const next = new Set(prev);
          if (mapped.status !== 'ok') next.add(step.id);
          return next;
        });
      } catch (cause) {
        setBanner(cause instanceof Error ? `Step test failed: ${cause.message}` : 'Step test failed.');
      } finally {
        setStepTestBusy(null);
      }
    },
    [connections, stepTestBusy],
  );

  /* ---------------- deploy ---------------- */

  const doDeploy = useCallback(
    async (confirmDestructive: boolean) => {
      if (!automation || !canManage || deploying) return;
      if (mode === 'new' || automation.id === 'new') {
        setBanner('Save the automation first — deploy needs a saved draft.');
        setDeployConfirmOpen(false);
        return;
      }
      setDeploying(true);
      setBanner(null);
      try {
        const updated = await deployStudioAutomation(automation.id, confirmDestructive);
        setAutomation(updated);
        setDeployConfirmOpen(false);
      } catch (cause) {
        setBanner(cause instanceof Error ? `Deploy failed: ${cause.message}` : 'Deploy failed.');
        setDeployConfirmOpen(false);
      } finally {
        setDeploying(false);
      }
    },
    [automation, canManage, deploying, mode],
  );

  const handleDeployClick = useCallback(() => {
    if (destructive.length > 0) setDeployConfirmOpen(true);
    else void doDeploy(false);
  }, [destructive.length, doDeploy]);

  const handleUndeploy = useCallback(async () => {
    if (!automation || !canManage || deploying) return;
    if (mode === 'new' || automation.id === 'new') return;
    setDeploying(true);
    setBanner(null);
    try {
      setAutomation(await undeployStudioAutomation(automation.id));
    } catch (cause) {
      setBanner(cause instanceof Error ? `Undeploy failed: ${cause.message}` : 'Undeploy failed.');
    } finally {
      setDeploying(false);
    }
  }, [automation, canManage, deploying, mode]);

  const copyWebhook = useCallback(async () => {
    const url = automation?.trigger.webhookUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* clipboard unavailable — the URL is still visible on the card */
    }
    setCopiedWebhook(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedWebhook(false), 2000);
  }, [automation?.trigger.webhookUrl]);

  /* ---------------- render ---------------- */

  if (loadState === 'loading') {
    return (
      <div className="space-y-2 max-w-2xl" aria-label="Loading builder">
        <Skeleton height={64} />
        <Skeleton height={120} />
        <Skeleton height={120} />
      </div>
    );
  }

  if (loadState === 'unavailable') {
    return (
      <div className="max-w-2xl rounded-lg px-6 py-10 text-center" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
        <h2 className="font-semibold" style={{ fontSize: 'var(--text-section-title)', color: 'var(--foreground)' }}>
          The automation builder API isn't available yet
        </h2>
        <p className="mt-2 text-sm mx-auto max-w-md" style={{ color: 'var(--muted-foreground)', lineHeight: 1.65 }}>
          The backend builder slice is still in flight. Saved automations, dry-runs, and deploys will
          work here once it lands — nothing here is simulated.
        </p>
        <Link to="/studio/automations" className="mt-5 inline-block">
          <Button variant="outline">Back to automations</Button>
        </Link>
      </div>
    );
  }

  if (loadState === 'notfound') {
    return (
      <div className="max-w-2xl rounded-lg px-6 py-10 text-center" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
        <h2 className="font-semibold" style={{ fontSize: 'var(--text-section-title)', color: 'var(--foreground)' }}>
          Automation not found
        </h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--muted-foreground)' }}>
          No automation with this id exists.
        </p>
        <Link to="/studio/automations" className="mt-5 inline-block">
          <Button variant="outline">Back to automations</Button>
        </Link>
      </div>
    );
  }

  if (loadState === 'error' || !automation) {
    return <ErrorState message={loadError ?? 'Could not load the automation.'} onRetry={() => void load()} />;
  }

  const setTrigger = (trigger: StudioTrigger) => {
    updateDraft((draft) => ({ ...draft, trigger, triggerKind: trigger.kind }));
  };

  const insertButton = (index: number) =>
    canManage ? (
      <div className="studio-insert">
        <button
          type="button"
          className="studio-insert-btn"
          aria-label={`Add step ${index === 0 ? 'at the start' : `after step ${index}`}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setAddMenu({ index, anchor: rect });
          }}
        >
          <IconPlus size={12} />
        </button>
      </div>
    ) : (
      <div className="studio-connector" aria-hidden="true">
        <span className="studio-connector-line" />
      </div>
    );

  return (
    <div className="studio-scope">
      {/* Top bar: breadcrumb / title / status / actions */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase" style={{ color: 'var(--muted-foreground)', letterSpacing: '0.06em' }} aria-label="Breadcrumb">
            Automations / {automation.title || automation.name}
          </p>
          <div className="mt-1.5 flex items-center gap-3">
            {canManage ? (
              <input
                aria-label="Automation title"
                value={automation.title}
                onChange={(e) => updateDraft((d) => ({ ...d, title: e.target.value }))}
                className="font-semibold bg-transparent"
                style={{
                  fontSize: 'var(--text-page-title)',
                  color: 'var(--foreground)',
                  letterSpacing: '-0.02em',
                  border: 'none',
                  padding: 0,
                  maxWidth: 420,
                }}
              />
            ) : (
              <h1 className="font-semibold truncate" style={{ fontSize: 'var(--text-page-title)', color: 'var(--foreground)', letterSpacing: '-0.02em' }}>
                {automation.title}
              </h1>
            )}
            <Badge tone={statusBadgeTone(automation.status)} title={`Status: ${automation.status}`}>
              <span aria-hidden="true" className="studio-dot mr-1.5" style={{ background: 'currentColor' }} />
              {statusLabel(automation.status)}
            </Badge>
            {dirty && (
              <span className="font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                unsaved changes
              </span>
            )}
          </div>
          {canManage ? (
            <input
              aria-label="Automation description"
              value={automation.description ?? ''}
              placeholder="What does this automation do?"
              onChange={(e) => updateDraft((d) => ({ ...d, description: e.target.value }))}
              className="bg-transparent w-full"
              style={{ border: 'none', padding: 0, fontSize: 'var(--text-secondary)', color: 'var(--muted-foreground)', maxWidth: 560 }}
            />
          ) : (
            automation.description && (
              <p className="mt-1 text-sm" style={{ color: 'var(--muted-foreground)' }}>{automation.description}</p>
            )
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {canTest && mode === 'edit' && automation.id !== 'new' && (
            <Button variant="outline" size="sm" onClick={() => setExplainOpen(true)}>
              Explain
            </Button>
          )}
          {canTest && (
            <Button variant="outline" size="sm" onClick={() => void handleTest()} disabled={testing}>
              {testing ? 'Testing…' : 'Test'}
            </Button>
          )}
          {canManage && (
            <Button variant="outline" size="sm" onClick={() => void handleSave()} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          )}
          {canManage &&
            (deployed ? (
              <Button variant="outline" size="sm" onClick={() => void handleUndeploy()} disabled={deploying}>
                {deploying ? 'Working…' : 'Undeploy'}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={handleDeployClick} disabled={deploying}>
                {deploying ? 'Deploying…' : 'Deploy'}
              </Button>
            ))}
        </div>
      </div>

      {banner && (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg px-4 py-3" role="alert" style={{ background: '#d9aa6814', border: '1px solid #d9aa6840' }}>
          <span className="flex-shrink-0 mt-0.5" style={{ color: '#d9aa68' }}>
            <IconAlert size={14} />
          </span>
          <p className="text-xs" style={{ color: 'var(--foreground)', lineHeight: 1.6 }}>{banner}</p>
        </div>
      )}
      {catalogNote && (
        <p className="mt-3 font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{catalogNote}</p>
      )}

      {/* Canvas + editor */}
      <div className="studio-builder-layout mt-6">
        <div className="studio-canvas mx-auto w-full" style={{ maxWidth: 640 }} aria-label="Automation canvas">
          <TriggerCard
            trigger={automation.trigger}
            selected={selectedId === 'trigger'}
            readOnly={!canManage}
            onSelect={() => setSelectedId('trigger')}
            onCopyWebhook={() => void copyWebhook()}
            copied={copiedWebhook}
          />

          {automation.steps.map((step, i) => (
            <div key={step.id} className="studio-canvas-item">
              {insertButton(i)}
              <StepCard
                step={step}
                index={i}
                isFirst={i === 0}
                isLast={i === automation.steps.length - 1}
                selected={selectedId === step.id}
                readOnly={!canManage}
                canTest={canTest}
                catalogById={catalogById}
                testResult={results?.get(step.id)}
                testing={testing}
                stepTestBusy={stepTestBusy === step.id}
                stepTestResultOpen={openResults.has(step.id)}
                onSelect={() => setSelectedId(step.id)}
                onMove={(dir) => handleMove(step.id, dir)}
                onDuplicate={() => handleDuplicate(step.id)}
                onDelete={() => handleDelete(step.id)}
                onTestStep={() => void handleTestStep(step)}
                onToggleStepResult={() =>
                  setOpenResults((prev) => {
                    const next = new Set(prev);
                    if (next.has(step.id)) next.delete(step.id);
                    else next.add(step.id);
                    return next;
                  })
                }
              />
            </div>
          ))}
          {insertButton(automation.steps.length)}

          {automation.steps.length === 0 && canManage && (
            <p className="mt-2 text-center text-xs" style={{ color: 'var(--muted-foreground)' }}>
              Use the + buttons to add your first step.
            </p>
          )}
        </div>

        <div className="studio-editor-panel">
          <StepEditorPanel
            selection={selection}
            catalog={catalog}
            catalogById={catalogById}
            connections={connections}
            readOnly={!canManage}
            onChangeTrigger={setTrigger}
            onChangeStep={(patch) => {
              if (selectedId && selectedId !== 'trigger') patchStep(selectedId, patch);
            }}
            onDeleteStep={() => {
              if (selectedId && selectedId !== 'trigger') handleDelete(selectedId);
            }}
            onClose={() => setSelectedId(null)}
          />
        </div>
      </div>

      {addMenu && (
        <AddStepMenu
          catalog={catalog}
          anchor={addMenu.anchor}
          onClose={() => setAddMenu(null)}
          onAdd={(kind, actionId) => addStep(addMenu.index, kind, actionId)}
          ai={aiSuggestions}
          onPickSuggestion={(step) => insertSuggestedStep(addMenu.index, step)}
        />
      )}

      {explainOpen && automation.id !== 'new' && (
        <ExplainPanel automationId={automation.id} onClose={() => setExplainOpen(false)} />
      )}

      {deployConfirmOpen && (
        <DeployConfirmModal
          destructive={destructive}
          automationTitle={automation.title}
          deploying={deploying}
          onConfirm={() => void doDeploy(true)}
          onCancel={() => setDeployConfirmOpen(false)}
        />
      )}
    </div>
  );
}
