import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type {
  ChooseFolderResponse,
  DetectedSource,
  IngestReview,
  KnownSourceSummary,
  RecoverableSessionSummary,
  RendererSettings,
  SessionSnapshot,
} from '@ingestarr/shared-types';
import type { SourceMediaDay } from '@ingestarr/shared-types';
import { SummaryScreen } from './SummaryScreen';
import { calculateProgressTelemetry } from './progress';
import {
  CopyableValue,
  exactBytes,
  Field,
  FieldList,
  formatDate,
  formatDateTime,
  formatDayLabel,
} from './util-ui';

type View = 'review' | 'progress' | 'complete' | 'summary' | 'sources' | 'settings';

function formatBytes(bytes: number): string {
  return exactBytes(bytes);
}

// Rotating palette for the Disk-Utility-style capacity bar. Distinct, evenly-spaced hues so
// adjacent date segments never blur together.
const SEGMENT_COLORS = [
  '#0a84ff',
  '#30d0c6',
  '#32d74b',
  '#ffd60a',
  '#ff9f0a',
  '#ff453a',
  '#bf5af2',
  '#ff375f',
  '#64d2ff',
  '#5e5ce6',
  '#ac8e68',
  '#98989d',
];

interface CapacitySegment {
  key: string;
  label: string;
  color: string;
  bytes: number;
  count: number;
}

// Turns the per-day (or, as a fallback, per-media-type) breakdown into coloured bar segments.
function buildSegments(
  byDay: readonly SourceMediaDay[] | undefined,
  totals: { photos: number; videos: number; other: number; bytes: number },
): CapacitySegment[] {
  if (byDay !== undefined && byDay.length > 0) {
    return byDay.map((day, index) => ({
      key: day.day,
      label: formatDayLabel(day.day),
      color: SEGMENT_COLORS[index % SEGMENT_COLORS.length] ?? '#0a84ff',
      bytes: day.bytes,
      count: day.photos + day.videos + day.other,
    }));
  }
  return [
    { key: 'photos', label: 'Photos', color: '#0a84ff', bytes: 0, count: totals.photos },
    { key: 'videos', label: 'Videos', color: '#bf5af2', bytes: 0, count: totals.videos },
    { key: 'other', label: 'Other', color: '#98989d', bytes: 0, count: totals.other },
  ].filter((segment) => segment.count > 0);
}

// Scans an online card for the media it currently holds (metadata-only walk, no copying) and
// renders a macOS Disk Utility-style capacity bar — segmented and coloured by capture date —
// plus a plain-text summary line, so the Sources tab shows "what's on this card" before ingest.
function SourceMediaCount({
  detectedSourceId,
  capacityBytes,
}: {
  detectedSourceId: string;
  capacityBytes?: number;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error' }
    | {
        status: 'ready';
        total: number;
        photos: number;
        videos: number;
        other: number;
        bytes: number;
        byDay?: SourceMediaDay[];
      }
  >({ status: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    void window.ingestarr.countSourceMedia({ detectedSourceId }).then((response) => {
      if (!active) return;
      if (response.ok) {
        setState({
          status: 'ready',
          total: response.total,
          photos: response.photos,
          videos: response.videos,
          other: response.other,
          bytes: response.bytes,
          ...(response.byDay === undefined ? {} : { byDay: response.byDay }),
        });
      } else {
        setState({ status: 'error' });
      }
    });
    return () => {
      active = false;
    };
  }, [detectedSourceId]);

  if (state.status === 'loading') {
    return (
      <p className="media-count is-loading" aria-live="polite">
        Counting media…
      </p>
    );
  }
  if (state.status === 'error') {
    return <p className="media-count is-error">Media count unavailable</p>;
  }

  const breakdown = [
    state.photos > 0 ? `${state.photos.toLocaleString()} photos` : undefined,
    state.videos > 0 ? `${state.videos.toLocaleString()} videos` : undefined,
    state.other > 0 ? `${state.other.toLocaleString()} other` : undefined,
  ].filter(Boolean);

  const segments = buildSegments(state.byDay, state);
  const used = state.bytes;
  // Scale segments against total capacity when known (so the empty remainder reads as free
  // space, exactly like Disk Utility); otherwise fill the bar with what's on the card.
  const scale = capacityBytes !== undefined && capacityBytes > used ? capacityBytes : used || 1;
  const hasBytes = used > 0 && state.byDay !== undefined && state.byDay.length > 0;
  const summary = (
    <p className="media-count" aria-live="polite">
      <strong>{state.total.toLocaleString()}</strong> media
      {breakdown.length > 0 ? <span> · {breakdown.join(' · ')}</span> : null}
      {used > 0 ? <span> · {exactBytes(used)}</span> : null}
    </p>
  );

  if (state.total === 0) {
    return summary;
  }

  const legend = segments.slice(0, 10);
  const overflow = segments.length - legend.length;

  return (
    <div className="capacity">
      <div
        className="capacity-bar"
        role="img"
        aria-label={
          capacityBytes === undefined
            ? `${state.total.toLocaleString()} media using ${exactBytes(used)}`
            : `${state.total.toLocaleString()} media using ${exactBytes(used)} of ${exactBytes(capacityBytes)}`
        }
      >
        {segments.map((segment) => {
          // With byte data, widths are proportional to size. Without it (media-type fallback),
          // fall back to an equal split so the colours are still legible.
          const width = hasBytes
            ? (segment.bytes / scale) * 100
            : 100 / Math.max(segments.length, 1);
          return (
            <span
              key={segment.key}
              className="capacity-seg"
              style={{ width: `${String(width)}%`, background: segment.color }}
              title={`${segment.label} · ${segment.count.toLocaleString()} files${segment.bytes > 0 ? ` · ${exactBytes(segment.bytes)}` : ''}`}
            />
          );
        })}
      </div>
      <ul className="capacity-legend">
        {legend.map((segment) => (
          <li key={segment.key}>
            <span
              className="legend-swatch"
              style={{ background: segment.color }}
              aria-hidden="true"
            />
            <span className="legend-label">{segment.label}</span>
            <span className="legend-value">
              {segment.count.toLocaleString()}
              {segment.bytes > 0 ? ` · ${exactBytes(segment.bytes)}` : ''}
            </span>
          </li>
        ))}
        {overflow > 0 && (
          <li className="legend-more">
            +{overflow.toLocaleString()} more {overflow === 1 ? 'day' : 'days'}
          </li>
        )}
      </ul>
      {summary}
    </div>
  );
}

function SessionFields({ session }: { session: SessionSnapshot }) {
  return (
    <FieldList label="Session details">
      <Field label="Session ID">
        <CopyableValue value={session.sessionId} label="session ID" />
      </Field>
      {session.sourceId !== undefined && (
        <Field label="Source ID">
          <CopyableValue value={session.sourceId} label="source ID" />
        </Field>
      )}
      <Field label="Status">
        <code>{session.status}</code>
      </Field>
      <Field label="Phase">
        <code>{session.phase}</code>
      </Field>
      <Field label="Bytes">
        {exactBytes(session.completedBytes)} / {exactBytes(session.totalBytes)}
      </Field>
      <Field label="Throughput">{session.throughputBytesPerSecond.toLocaleString()} B/s</Field>
      <Field label="Updated">
        <time dateTime={session.updatedAt}>{session.updatedAt}</time>
      </Field>
    </FieldList>
  );
}

function ErrorList({ session }: { session: SessionSnapshot }) {
  if (session.errors.length === 0) return null;
  return (
    <details className="errors" open>
      <summary>{session.errors.length} ingest errors</summary>
      <div className="data-table">
        {session.errors.slice(-100).map((item, index) => {
          const raw = `${item.code}\t${item.filename ?? ''}\t${item.message}`;
          return (
            <div className="data-row" key={`${item.code}-${String(index)}`}>
              <CopyableValue value={raw} label={`error ${String(index + 1)}`} />
              <code>{item.code}</code>
              <span>{item.filename ?? '—'}</span>
              <span>{item.message}</span>
            </div>
          );
        })}
      </div>
    </details>
  );
}

// Compact inline nickname editor: shows just a pencil button beside the card title until the user
// clicks it, then reveals the input + Save/Cancel. Keeps the card short (no always-on form).
function InlineNicknameEditor({
  initialValue,
  ariaLabel,
  onSave,
}: {
  initialValue: string;
  ariaLabel: string;
  onSave: (nickname: string | null) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setValue(initialValue);
  }, [initialValue, editing]);

  const submit = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      const result = await onSave(value.trim() === '' ? null : value.trim());
      if (!result.ok) {
        setError(result.message ?? 'Could not save the nickname.');
        return;
      }
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="icon-button"
        aria-label={`Edit ${ariaLabel}`}
        title="Edit nickname"
        onClick={() => setEditing(true)}
      >
        <span aria-hidden="true">✎</span>
      </button>
    );
  }

  return (
    <span className="nickname-editor">
      <input
        type="text"
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit();
          if (event.key === 'Escape') setEditing(false);
        }}
        placeholder="canon-r5"
        aria-label={ariaLabel}
      />
      <button type="button" className="secondary" disabled={saving} onClick={() => void submit()}>
        Save
      </button>
      <button type="button" className="quiet" disabled={saving} onClick={() => setEditing(false)}>
        Cancel
      </button>
      {error !== undefined && <span className="field-error">{error}</span>}
    </span>
  );
}

function NicknameEditor({ source, onSaved }: { source: KnownSourceSummary; onSaved: () => void }) {
  return (
    <InlineNicknameEditor
      initialValue={source.nickname ?? ''}
      ariaLabel={`Nickname for ${source.displayName}`}
      onSave={async (nickname) => {
        const response = await window.ingestarr.setSourceNickname({
          sourceId: source.id,
          nickname,
        });
        if (!response.ok) return { ok: false, message: response.error.message };
        onSaved();
        return { ok: true };
      }}
    />
  );
}

function DetectedSourceNicknameEditor({
  detectedSourceId,
  label,
  onSaved,
}: {
  detectedSourceId: string;
  label: string;
  onSaved: () => void;
}) {
  return (
    <InlineNicknameEditor
      initialValue=""
      ariaLabel={`Nickname for ${label}`}
      onSave={async (nickname) => {
        const response = await window.ingestarr.registerSource({ detectedSourceId, nickname });
        if (!response.ok) return { ok: false, message: response.error.message };
        onSaved();
        return { ok: true };
      }}
    />
  );
}

const NAV_ITEMS: Record<'sources' | 'summary' | 'settings', { label: string; icon: string }> = {
  sources: { label: 'Sources', icon: '⧉' },
  summary: { label: 'Summary', icon: '▦' },
  settings: { label: 'Settings', icon: '⚙' },
};

function Navigation({
  view,
  navigate,
  autoIngest,
  autoIngestReady,
  onToggleAutoIngest,
  health,
}: {
  view: View;
  navigate(view: 'summary' | 'sources' | 'settings'): void;
  autoIngest: boolean;
  autoIngestReady: boolean;
  onToggleAutoIngest(next: boolean): void;
  health: string;
}) {
  return (
    <nav className="app-navigation" aria-label="Primary">
      <div className="sidebar-header">
        <strong>Ingestarr</strong>
      </div>
      <div className="sidebar-group">
        {(['sources', 'summary', 'settings'] as const).map((item) => (
          <button
            type="button"
            className="nav-item"
            aria-current={view === item ? 'page' : undefined}
            onClick={() => navigate(item)}
            key={item}
          >
            <span className="nav-icon" aria-hidden="true">
              {NAV_ITEMS[item].icon}
            </span>
            {NAV_ITEMS[item].label}
          </button>
        ))}
      </div>
      <div className="sidebar-footer">
        <label className={`auto-toggle${autoIngest ? ' is-on' : ''}`}>
          <span className="auto-toggle-copy">
            <span className="auto-toggle-title">Automatic mode</span>
            <span className="auto-toggle-sub">
              {autoIngest
                ? autoIngestReady
                  ? 'Cards ingest on insert'
                  : 'Set a destination to arm'
                : 'Ingest cards manually'}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={autoIngest}
            aria-label="Automatic mode"
            onChange={(event) => onToggleAutoIngest(event.currentTarget.checked)}
          />
        </label>
        <p className="sidebar-status" aria-live="polite">
          <span
            className={`status-dot${health.startsWith('Ready') ? ' is-ok' : ''}`}
            aria-hidden="true"
          />
          {health}
        </p>
      </div>
    </nav>
  );
}

function SettingsScreen({
  headingRef,
  onSettingsChanged,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>;
  onSettingsChanged?: () => void;
}) {
  const [settings, setSettings] = useState<RendererSettings>();
  const [destinationCapabilityId, setDestinationCapabilityId] = useState<string>();
  const [preview, setPreview] = useState('');
  const [status, setStatus] = useState('Loading settings…');

  useEffect(() => {
    let active = true;
    void window.ingestarr.getSettings().then((response) => {
      if (!active) return;
      if (response.ok) {
        setSettings(response.settings);
        setStatus('');
      } else setStatus(response.error.message);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (settings === undefined) return;
    const timer = window.setTimeout(() => {
      void window.ingestarr
        .validateTemplate({ template: settings.destinationTemplate })
        .then((response) => {
          setPreview(response.ok ? response.preview : response.errors.join(' '));
        });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [settings?.destinationTemplate]);

  if (settings === undefined) {
    return (
      <main className="content-shell">
        <p aria-live="polite">{status}</p>
      </main>
    );
  }

  const chooseDestination = async (): Promise<void> => {
    const selected = await window.ingestarr.chooseDestinationFolder();
    if (selected.status !== 'selected') return;
    setDestinationCapabilityId(selected.capabilityId);
    setSettings({
      ...settings,
      destination: { ...settings.destination, configured: true, label: selected.label },
    });
  };
  const save = async (): Promise<void> => {
    setStatus('Saving…');
    const response = await window.ingestarr.updateSettings({
      ...(destinationCapabilityId === undefined ? {} : { destinationCapabilityId }),
      allowedExtensions: settings.allowedExtensions,
      excludedPathPatterns: settings.excludedPathPatterns,
      destinationTemplate: settings.destinationTemplate,
      copyConcurrency: settings.copyConcurrency,
      groupByNicknameInDestination: settings.groupByNicknameInDestination,
      perCardEventLog: settings.perCardEventLog,
      autoIngest: settings.autoIngest,
      thumbnail: settings.thumbnail,
    });
    if (response.ok) {
      setSettings(response.settings);
      setDestinationCapabilityId(undefined);
      setStatus('Settings saved.');
      onSettingsChanged?.();
    } else setStatus(response.error.message);
  };

  return (
    <main className="content-shell">
      <section className="panel settings-panel">
        <p className="eyebrow">CONFIG / RENDERER</p>
        <h1 ref={headingRef} tabIndex={-1}>
          Settings
        </h1>
        <FieldList label="Resolved settings">
          <Field label="Destination">
            <CopyableValue
              value={settings.destination.path ?? 'not-configured'}
              label="destination path"
            />
          </Field>
          <Field label="Verification">
            <code>{String(settings.verifyCopies)}</code>
          </Field>
          <Field label="Thumbnail cache">
            <code>
              {settings.thumbnail.cachePolicy} / {exactBytes(settings.thumbnail.cacheLimitBytes)}
            </code>
          </Field>
        </FieldList>
        <div className="form-grid">
          <label>
            Destination
            <span>
              {settings.destination.path ?? settings.destination.label ?? 'Not configured'}
            </span>
          </label>
          <button type="button" className="secondary" onClick={() => void chooseDestination()}>
            Choose destination
          </button>
          {settings.destination.defaultPath !== undefined &&
            settings.destination.path !== settings.destination.defaultPath && (
              <>
                <p className="field-hint">
                  System default: <code>{settings.destination.defaultPath}</code>
                </p>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => {
                    setStatus('Resetting to system default…');
                    void window.ingestarr.resetDestinationToDefault().then((response) => {
                      if (response.ok) {
                        setSettings(response.settings);
                        setDestinationCapabilityId(undefined);
                        setStatus('Destination reset to system default.');
                      } else setStatus(response.error.message);
                    });
                  }}
                >
                  Reset to system default
                </button>
              </>
            )}
          <label>
            Naming template
            <input
              value={settings.destinationTemplate}
              onChange={(event) =>
                setSettings({ ...settings, destinationTemplate: event.currentTarget.value })
              }
            />
          </label>
          <p className="preview" aria-live="polite">
            <span>Live preview</span>
            {preview === '' ? (
              <strong>Validating…</strong>
            ) : (
              <CopyableValue value={preview} label="destination preview" />
            )}
          </p>
          <label>
            Allowed extensions
            <input
              value={settings.allowedExtensions.join(', ')}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  allowedExtensions: event.currentTarget.value
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label>
            Exclusions
            <input
              value={settings.excludedPathPatterns.join(', ')}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  excludedPathPatterns: event.currentTarget.value
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label>
            Copy concurrency
            <input
              type="number"
              min={1}
              max={4}
              value={settings.copyConcurrency}
              onChange={(event) =>
                setSettings({ ...settings, copyConcurrency: Number(event.currentTarget.value) })
              }
            />
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={settings.groupByNicknameInDestination}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  groupByNicknameInDestination: event.currentTarget.checked,
                })
              }
            />
            Group destination by source nickname (adds a {'{nickname}'} template token)
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={settings.perCardEventLog}
              onChange={(event) =>
                setSettings({ ...settings, perCardEventLog: event.currentTarget.checked })
              }
            />
            Write a plain-text event log to .ingestarr on each card&apos;s destination
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={settings.autoIngest}
              onChange={(event) =>
                setSettings({ ...settings, autoIngest: event.currentTarget.checked })
              }
            />
            Automatically ingest cards on insert (fully automated mode)
          </label>
        </div>
        <button type="button" className="primary" onClick={() => void save()}>
          Save settings
        </button>
        <p aria-live="polite">{status}</p>
      </section>
    </main>
  );
}

export function App() {
  const [view, setView] = useState<View>('sources');
  const [health, setHealth] = useState('Connecting…');
  const [source, setSource] = useState<ChooseFolderResponse>();
  const [destination, setDestination] = useState<ChooseFolderResponse>();
  const [review, setReview] = useState<IngestReview>();
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set());
  const [sourceDecision, setSourceDecision] = useState<'new' | string>();
  const [session, setSession] = useState<SessionSnapshot>();
  const [sessionId, setSessionId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [startInFlight, setStartInFlight] = useState(false);
  const [detectedSources, setDetectedSources] = useState<DetectedSource[]>([]);
  const [knownSources, setKnownSources] = useState<KnownSourceSummary[]>([]);
  const [showOfflineSources, setShowOfflineSources] = useState(true);
  const [recoverable, setRecoverable] = useState<RecoverableSessionSummary[]>([]);
  const [settings, setSettings] = useState<RendererSettings>();
  const heading = useRef<HTMLHeadingElement>(null);

  const refreshSettings = useCallback((): void => {
    void window.ingestarr.getSettings().then((response) => {
      if (response.ok) setSettings(response.settings);
    });
  }, []);

  const toggleAutoIngest = useCallback(
    (next: boolean): void => {
      if (settings === undefined) return;
      setSettings({ ...settings, autoIngest: next });
      void window.ingestarr
        .updateSettings({
          allowedExtensions: settings.allowedExtensions,
          excludedPathPatterns: settings.excludedPathPatterns,
          destinationTemplate: settings.destinationTemplate,
          copyConcurrency: settings.copyConcurrency,
          groupByNicknameInDestination: settings.groupByNicknameInDestination,
          perCardEventLog: settings.perCardEventLog,
          autoIngest: next,
          thumbnail: settings.thumbnail,
        })
        .then((response) => {
          if (response.ok) setSettings(response.settings);
        });
    },
    [settings],
  );

  const refreshKnownSources = useCallback((): void => {
    void window.ingestarr.listKnownSources().then((response) => {
      if (response.ok) setKnownSources(response.sources);
    });
  }, []);

  useEffect(() => {
    let active = true;
    const refreshDetected = (): void => {
      void window.ingestarr.listDetectedSources().then((response) => {
        if (active && response.ok) setDetectedSources(response.sources);
      });
      // Known sources' online status is derived from currently-detected volume
      // IDs, so it must be refreshed alongside detected sources to stay live.
      refreshKnownSources();
    };
    refreshDetected();
    refreshSettings();
    void window.ingestarr.listRecoverableSessions().then((response) => {
      if (active && response.ok) setRecoverable(response.sessions);
    });
    void window.ingestarr
      .health()
      .then((result) => setHealth(`Ready · v${result.version}`))
      .catch(() => setHealth('Desktop service unavailable'));
    const unsubscribeProgress = window.ingestarr.onProgress((next) => {
      setSession(next);
      setSessionId(next.sessionId);
      setView(next.status === 'completed' ? 'complete' : 'progress');
    });
    const unsubscribeDetected = window.ingestarr.onDetectedSourcesChanged(refreshDetected);
    return () => {
      active = false;
      unsubscribeProgress();
      unsubscribeDetected();
    };
  }, []);

  useEffect(() => {
    heading.current?.focus();
  }, [view]);

  useEffect(() => {
    if (
      session === undefined ||
      !['completed', 'failed', 'cancelled'].includes(session.status) ||
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted'
    ) {
      return;
    }
    new Notification('Ingestarr', {
      body:
        session.status === 'completed'
          ? `${String(session.completedFiles)} files verified.`
          : `Ingest ${session.status}.`,
    });
  }, [session?.status]);

  // Builds the ingest plan. With no destinationCapabilityId, the backend uses the destination
  // configured in Settings — so "Start ingest" needs zero clicks once a destination exists, while
  // a supplied capability lets the user override it for this ingest only.
  const runReview = async (
    sourceCapabilityId: string,
    destinationCapabilityId?: string,
  ): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await window.ingestarr.review({
        sourceCapabilityId,
        ...(destinationCapabilityId === undefined ? {} : { destinationCapabilityId }),
      });
      if (!response.ok) {
        setReview(undefined);
        setError(response.error.message);
        return;
      }
      setReview(response.value);
      // Default to ingesting every date on the card; the user can deselect any before starting.
      setSelectedDays(new Set(response.value.byDay.map((day) => day.day)));
      setSourceDecision(response.value.source.requiresConfirmation ? undefined : 'new');
    } catch {
      setReview(undefined);
      setError('The folders could not be reviewed. Choose them again.');
    } finally {
      setBusy(false);
    }
  };

  const chooseSource = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const selected = await window.ingestarr.chooseSourceFolder();
      if (selected.status === 'selected') {
        setSource(selected);
        setDestination(undefined);
        setReview(undefined);
        setSelectedDays(new Set());
        setView('review');
        // Auto-plan against the configured destination so the user lands on a ready-to-start
        // review. Falls back to a manual "Choose destination" when none is configured.
        if (settings?.destination.configured === true) {
          await runReview(selected.capabilityId);
        }
      }
    } catch {
      setError('The source folder could not be selected.');
    } finally {
      setBusy(false);
    }
  };

  const chooseDestination = async (): Promise<void> => {
    if (busy || source?.status !== 'selected') return;
    setBusy(true);
    setError(undefined);
    try {
      const selected = await window.ingestarr.chooseDestinationFolder();
      if (selected.status === 'cancelled') return;
      setDestination(selected);
      await runReview(source.capabilityId, selected.capabilityId);
    } catch {
      setReview(undefined);
      setError('The folders could not be reviewed. Choose them again.');
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    if (busy || review === undefined) return;
    setBusy(true);
    setStartInFlight(true);
    setError(undefined);
    try {
      // Only send a day allowlist when the user has actually narrowed the selection; sending all
      // days (or none available) keeps the default "ingest everything" behaviour.
      const allDays = review.byDay.map((day) => day.day);
      const narrowed = allDays.length > 0 && selectedDays.size < allDays.length;
      const response = await window.ingestarr.start({
        reviewId: review.reviewId,
        ...(review.source.requiresConfirmation
          ? {
              sourceDecision:
                sourceDecision === 'new'
                  ? ({ action: 'new' } as const)
                  : ({ action: 'existing', sourceId: sourceDecision ?? '' } as const),
            }
          : {}),
        ...(narrowed ? { includedCaptureDays: [...selectedDays] } : {}),
      });
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setSessionId(response.sessionId);
      const durable = await window.ingestarr.getSession({ sessionId: response.sessionId });
      if (durable.ok) setSession(durable.session);
      setView('progress');
    } catch {
      setError('The ingest could not be started. Review the folders and try again.');
    } finally {
      setBusy(false);
      setStartInFlight(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (busy || sessionId === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await window.ingestarr.cancel({ sessionId });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError('The cancellation request could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const reset = (): void => {
    setView('sources');
    setSource(undefined);
    setDestination(undefined);
    setReview(undefined);
    setSelectedDays(new Set());
    setSourceDecision(undefined);
    setSession(undefined);
    setSessionId(undefined);
    setError(undefined);
  };

  const retryReview = (): void => {
    setReview(undefined);
    setSelectedDays(new Set());
    setDestination(undefined);
    setSession(undefined);
    setSessionId(undefined);
    setError(undefined);
    setView(source?.status === 'selected' ? 'review' : 'sources');
  };

  const useDetectedSource = (detected: DetectedSource): void => {
    setSource({
      status: 'selected',
      capabilityId: detected.capabilityId,
      label: detected.label,
      displayPath: detected.online ? 'Detected removable source' : 'Source offline',
      expiresAt: detected.expiresAt,
    });
    setDestination(undefined);
    setReview(undefined);
    setSelectedDays(new Set());
    setView('review');
    // Plan straight away against the configured destination so the review shows what's on the
    // card (grouped by date) and is ready to start; otherwise the user picks a destination first.
    if (settings?.destination.configured === true) {
      void runReview(detected.capabilityId);
    }
  };

  const navigate = (next: 'summary' | 'sources' | 'settings'): void => {
    setView(next);
  };

  // Explains, in plain language, exactly why "Start ingest" is not clickable
  // right now. Surfaced as visible helper text (not just a title attribute)
  // so the reason is available to every user, not only those who hover long
  // enough to see a native tooltip.
  const startBlockedReason: string | undefined = busy
    ? 'Another operation (choosing folders or reviewing) is currently in progress. Wait for it to finish before starting the ingest.'
    : review === undefined
      ? 'No ingest plan yet. Choose a destination folder above to review the source and destination before starting.'
      : review.source.requiresConfirmation && sourceDecision === undefined
        ? 'Confirm above whether this is a known source or a new one before starting the ingest.'
        : review.byDay.length > 0 && selectedDays.size === 0
          ? 'Select at least one date to ingest.'
          : undefined;

  const navigation = (
    <Navigation
      view={view}
      navigate={navigate}
      autoIngest={settings?.autoIngest ?? false}
      autoIngestReady={settings?.destination.configured ?? false}
      onToggleAutoIngest={toggleAutoIngest}
      health={health}
    />
  );

  const alert =
    error === undefined ? null : (
      <p role="alert" className="alert">
        {error}
      </p>
    );

  if (view === 'summary') {
    return (
      <>
        {navigation}
        <SummaryScreen headingRef={heading} onBack={reset} />
      </>
    );
  }

  if (view === 'settings') {
    return (
      <>
        {navigation}
        <SettingsScreen headingRef={heading} onSettingsChanged={refreshSettings} />
      </>
    );
  }

  if (view === 'sources') {
    // Collapse the "known source" and its currently-detected volume into one card. A detected
    // volume that resolved (on-card marker / strong id) to a known source in the list is folded
    // into that known card as "live" hardware, rather than shown a second time — this is the fix
    // for the long-standing "why am I seeing two of the same card?" confusion.
    const detectedByKnownId = new Map<string, DetectedSource>();
    for (const detected of detectedSources) {
      if (detected.knownSourceId !== undefined)
        detectedByKnownId.set(detected.knownSourceId, detected);
    }
    const unregisteredDetected = detectedSources.filter(
      (detected) =>
        detected.knownSourceId === undefined ||
        !knownSources.some((known) => known.id === detected.knownSourceId),
    );

    type SourceCard =
      | {
          kind: 'known';
          id: string;
          name: string;
          online: boolean;
          known: KnownSourceSummary;
          live?: DetectedSource;
        }
      | { kind: 'new'; id: string; name: string; online: boolean; detected: DetectedSource };
    const cards: SourceCard[] = [
      ...knownSources.map((known): SourceCard => {
        const live = detectedByKnownId.get(known.id);
        return {
          kind: 'known',
          id: known.id,
          name: known.nickname ?? known.displayName,
          online: known.online || (live?.online ?? false),
          known,
          ...(live === undefined ? {} : { live }),
        };
      }),
      ...unregisteredDetected.map((detected): SourceCard => ({
        kind: 'new',
        id: detected.id,
        name: detected.label,
        online: detected.online,
        detected,
      })),
    ];
    // Online cards first (that's what the user is here to act on), then alphabetical.
    cards.sort((a, b) =>
      a.online === b.online ? a.name.localeCompare(b.name) : a.online ? -1 : 1,
    );
    const onlineCount = cards.filter((card) => card.online).length;
    const offlineCount = cards.length - onlineCount;
    const visibleCards = showOfflineSources ? cards : cards.filter((card) => card.online);

    const renderKnownCard = (known: KnownSourceSummary, live?: DetectedSource) => {
      const online = known.online || (live?.online ?? false);
      const capacity = live?.capacityBytes;
      const makeModel = [live?.deviceVendor, live?.deviceModel].filter(Boolean).join(' ');
      const meta = [
        makeModel || undefined,
        live?.fsType,
        capacity === undefined ? undefined : formatBytes(capacity),
      ].filter(Boolean);
      return (
        <article className={`card-row${online ? ' is-online' : ''}`} key={known.id}>
          <div className="card-row-main">
            <div className="card-row-title">
              <span className={`status-dot${online ? ' is-ok' : ''}`} aria-hidden="true" />
              <strong>{known.nickname ?? known.displayName}</strong>
              {online && <NicknameEditor source={known} onSaved={refreshKnownSources} />}
              <span className={`status-pill${online ? ' is-online' : ''}`}>
                {online ? 'Online' : 'Offline'}
              </span>
              {known.throughput?.isSlow === true && (
                <span className="badge-warning" title="Recent throughput is unusually low">
                  Slow
                </span>
              )}
              <span className="card-row-spacer" />
              <button
                type="button"
                className="primary"
                disabled={live?.online !== true}
                onClick={() => {
                  if (live !== undefined) useDetectedSource(live);
                }}
              >
                Start
              </button>
            </div>
            <p className="card-row-meta">
              {meta.length > 0
                ? meta.join(' · ')
                : `${String(known.sessionCount)} sessions · ${String(known.verifiedMediaCount)} verified · ${formatBytes(known.verifiedBytes)}`}
            </p>
            {live?.online === true ? (
              <SourceMediaCount
                detectedSourceId={live.id}
                {...(live.capacityBytes === undefined ? {} : { capacityBytes: live.capacityBytes })}
              />
            ) : (
              <p className="media-count is-offline">
                <strong>{known.verifiedMediaCount.toLocaleString()}</strong> media verified in
                archive
              </p>
            )}
          </div>
          <details className="card-advanced">
            <summary>Technical details</summary>
            <dl className="tech-list">
              <div>
                <dt>Source ID</dt>
                <dd>
                  <CopyableValue value={known.id} label="source ID" wrap />
                </dd>
              </div>
              <div>
                <dt>Source type</dt>
                <dd>
                  <code>{known.kind}</code>
                </dd>
              </div>
              {known.fingerprint !== undefined && (
                <div>
                  <dt>Fingerprint v{String(known.algorithmVersion ?? '?')}</dt>
                  <dd>
                    <CopyableValue value={known.fingerprint} label="source fingerprint" wrap />
                  </dd>
                </div>
              )}
              <div>
                <dt>First seen</dt>
                <dd>
                  <time dateTime={known.firstSeenAt}>{formatDateTime(known.firstSeenAt)}</time>
                </dd>
              </div>
              <div>
                <dt>Last seen</dt>
                <dd>
                  <time dateTime={known.lastSeenAt}>{formatDateTime(known.lastSeenAt)}</time>
                </dd>
              </div>
              <div>
                <dt>Totals</dt>
                <dd>
                  {known.sessionCount} sessions · {known.verifiedMediaCount} verified ·{' '}
                  {formatBytes(known.verifiedBytes)}
                </dd>
              </div>
              <div>
                <dt>Identity</dt>
                <dd>
                  <code>{known.identityConfidence}</code>
                </dd>
              </div>
              {known.throughput !== undefined && (
                <div>
                  <dt>Throughput</dt>
                  <dd>
                    {Math.round(known.throughput.lastBytesPerSecond / 1_000_000)} MB/s last ·{' '}
                    {Math.round(known.throughput.averageBytesPerSecond / 1_000_000)} MB/s avg
                    {known.throughput.isSlow ? ' · flagged slow' : ''}
                  </dd>
                </div>
              )}
            </dl>
          </details>
        </article>
      );
    };

    const renderNewCard = (detected: DetectedSource) => {
      const makeModel =
        [detected.deviceVendor, detected.deviceModel].filter(Boolean).join(' ') ||
        'Unknown make/model';
      const formatCapacity = [
        detected.fsType,
        detected.capacityBytes === undefined ? undefined : formatBytes(detected.capacityBytes),
      ]
        .filter(Boolean)
        .join(' · ');
      return (
        <article
          className={`card-row is-new${detected.online ? ' is-online' : ''}`}
          key={detected.id}
        >
          <div className="card-row-main">
            <div className="card-row-title">
              <span className={`status-dot${detected.online ? ' is-ok' : ''}`} aria-hidden="true" />
              <strong>{detected.label}</strong>
              {detected.online && (
                <DetectedSourceNicknameEditor
                  detectedSourceId={detected.id}
                  label={detected.label}
                  onSaved={() => {
                    refreshKnownSources();
                  }}
                />
              )}
              <span className="status-pill is-accent">New card</span>
              <span className="card-row-spacer" />
              <button
                type="button"
                className="primary"
                disabled={!detected.online}
                onClick={() => useDetectedSource(detected)}
              >
                Start
              </button>
            </div>
            <p className="card-row-meta">
              <span>{makeModel}</span>
              {formatCapacity !== '' && (
                <>
                  {' · '}
                  <span>{formatCapacity}</span>
                </>
              )}
            </p>
            {detected.online && (
              <SourceMediaCount
                detectedSourceId={detected.id}
                {...(detected.capacityBytes === undefined
                  ? {}
                  : { capacityBytes: detected.capacityBytes })}
              />
            )}
          </div>
          <details className="card-advanced">
            <summary>Technical details</summary>
            <dl className="tech-list">
              <div>
                <dt>Detected ID</dt>
                <dd>
                  <CopyableValue value={detected.id} label="detected source ID" wrap />
                </dd>
              </div>
              <div>
                <dt>Source type</dt>
                <dd>
                  <code>{detected.kind}</code>
                </dd>
              </div>
              {detected.strongPlatformId !== undefined && (
                <div>
                  <dt>Platform volume ID</dt>
                  <dd>
                    <CopyableValue
                      value={detected.strongPlatformId}
                      label="platform volume ID"
                      wrap
                    />
                  </dd>
                </div>
              )}
              <div>
                <dt>Identity</dt>
                <dd>
                  {detected.identityConfidence} · {detected.reasons.join(', ')}
                </dd>
              </div>
            </dl>
          </details>
        </article>
      );
    };

    return (
      <>
        {navigation}
        <main className="content-shell">
          <section className="panel">
            <header className="panel-head">
              <div>
                <p className="eyebrow">Cards</p>
                <h1 ref={heading} tabIndex={-1}>
                  Sources
                </h1>
              </div>
              <div className="panel-head-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void chooseSource()}
                  disabled={busy}
                >
                  {busy ? 'Choosing…' : 'Choose source folder'}
                </button>
                <span className="count-pill">{cards.length}</span>
              </div>
            </header>
            <p className="panel-lede">
              Cards are detected automatically the moment they&apos;re inserted. Name a card once
              and Ingestarr remembers it — the same card is never shown twice. You can also choose a
              folder manually to ingest from anywhere.
            </p>
            {recoverable.length > 0 && (
              <section className="resume-banner" aria-label="Recover interrupted ingest">
                <strong>Interrupted ingest found</strong>
                <span>
                  {recoverable[0]?.completedFiles ?? 0} of {recoverable[0]?.totalFiles ?? 0} files
                  verified
                </span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    const claim = recoverable[0];
                    if (claim === undefined) return;
                    void window.ingestarr.chooseSourceFolder().then(async (selected) => {
                      if (selected.status !== 'selected') return;
                      const response = await window.ingestarr.recoverSession({
                        claimCapabilityId: claim.claimCapabilityId,
                        action: 'resume',
                        sourceCapabilityId: selected.capabilityId,
                      });
                      if (!response.ok || response.result.action !== 'resume') {
                        if (!response.ok) setError(response.error.message);
                        return;
                      }
                      setSession(response.result.session);
                      setSessionId(response.result.session.sessionId);
                      setView(
                        response.result.session.status === 'completed' ? 'complete' : 'progress',
                      );
                    });
                  }}
                >
                  Resume ingest
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => {
                    const claim = recoverable[0];
                    if (claim === undefined) return;
                    void window.ingestarr
                      .recoverSession({
                        claimCapabilityId: claim.claimCapabilityId,
                        action: 'cleanup',
                      })
                      .then((response) => {
                        if (response.ok) setRecoverable((current) => current.slice(1));
                        else setError(response.error.message);
                      });
                  }}
                >
                  Clean up
                </button>
              </section>
            )}
            {alert}
            {cards.length > 0 && (
              <div className="sources-toolbar">
                <p className="sources-counts" aria-live="polite">
                  <span className="count-chip is-online">
                    <span className="status-dot is-ok" aria-hidden="true" />
                    {onlineCount} online
                  </span>
                  <span className="count-chip">
                    <span className="status-dot" aria-hidden="true" />
                    {offlineCount} offline
                  </span>
                </p>
                {offlineCount > 0 && (
                  <button
                    type="button"
                    className="quiet"
                    aria-pressed={!showOfflineSources}
                    onClick={() => setShowOfflineSources((current) => !current)}
                  >
                    {showOfflineSources ? `Hide offline (${String(offlineCount)})` : 'Show offline'}
                  </button>
                )}
              </div>
            )}
            {cards.length === 0 && (
              <div className="empty-state">
                <strong>No cards yet</strong>
                <span>Insert an SD card, or use “Choose source folder” to ingest manually.</span>
              </div>
            )}
            {cards.length > 0 && visibleCards.length === 0 && (
              <div className="empty-state">
                <strong>All cards are offline</strong>
                <span>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => setShowOfflineSources(true)}
                  >
                    Show offline cards
                  </button>
                </span>
              </div>
            )}
            <div className="card-list">
              {visibleCards.map((card) =>
                card.kind === 'known'
                  ? renderKnownCard(card.known, card.live)
                  : renderNewCard(card.detected),
              )}
            </div>
          </section>
        </main>
      </>
    );
  }

  if (view === 'review') {
    const destinationLabel =
      destination?.status === 'selected'
        ? destination.label
        : settings?.destination.configured === true
          ? (settings.destination.label ?? settings.destination.path ?? 'Configured destination')
          : 'Not set';
    const usingSettingsDestination =
      destination?.status !== 'selected' && settings?.destination.configured === true;
    const selectedTotals = (review?.byDay ?? [])
      .filter((day) => selectedDays.has(day.day))
      .reduce(
        (totals, day) => ({
          files: totals.files + day.photos + day.videos + day.other,
          bytes: totals.bytes + day.bytes,
        }),
        { files: 0, bytes: 0 },
      );
    const allSelected =
      review !== undefined && review.byDay.length > 0 && selectedDays.size === review.byDay.length;
    const toggleDay = (day: string): void => {
      setSelectedDays((current) => {
        const next = new Set(current);
        if (next.has(day)) next.delete(day);
        else next.add(day);
        return next;
      });
    };
    return (
      <>
        {navigation}
        <main className="shell">
          <section className="panel">
            <p className="eyebrow">INGEST / PLAN</p>
            <h1 ref={heading} tabIndex={-1}>
              Review source
            </h1>
            <div className="identity">
              <div>
                <span>Source</span>
                <strong>{source?.status === 'selected' ? source.label : 'Unknown'}</strong>
              </div>
              <div>
                <span>Destination</span>
                <strong>
                  {destinationLabel}
                  {usingSettingsDestination && <span className="tag-default"> default</span>}
                </strong>
              </div>
              {review && (
                <div>
                  <span>Identity</span>
                  <strong>
                    {review.source.identity} · {review.source.confidence} confidence
                  </strong>
                </div>
              )}
            </div>
            {review?.source.requiresConfirmation && (
              <fieldset className="source-confirmation">
                <legend>Confirm source identity</legend>
                {review.source.candidates?.map((candidate) => (
                  <label key={candidate.sourceId}>
                    <input
                      type="radio"
                      name="source-identity"
                      checked={sourceDecision === candidate.sourceId}
                      onChange={() => setSourceDecision(candidate.sourceId)}
                    />
                    Use existing source “{candidate.displayName}” ({candidate.confidence})
                    <CopyableValue value={candidate.sourceId} label="candidate source ID" />
                  </label>
                ))}
                <label>
                  <input
                    type="radio"
                    name="source-identity"
                    checked={sourceDecision === 'new'}
                    onChange={() => setSourceDecision('new')}
                  />
                  Create a new source and keep these cards separate
                </label>
              </fieldset>
            )}
            {review && (
              <>
                <div className="metrics" aria-label="Review estimates">
                  <strong>{review.counts.new} new</strong>
                  <strong>{review.counts.known} known</strong>
                  <strong>{review.counts.ambiguous} ambiguous</strong>
                  <strong>{review.counts.recoverable} recoverable</strong>
                  <strong>{formatBytes(review.estimatedBytes)}</strong>
                </div>
                {review.byDay.length > 0 && (
                  <fieldset className="date-select">
                    <div className="date-select-head">
                      <legend>Media by date</legend>
                      <div className="date-select-summary" aria-live="polite">
                        <span>
                          <strong>{selectedTotals.files.toLocaleString()}</strong> of{' '}
                          {review.byDay
                            .reduce((sum, day) => sum + day.photos + day.videos + day.other, 0)
                            .toLocaleString()}{' '}
                          files · {formatBytes(selectedTotals.bytes)}
                        </span>
                        <button
                          type="button"
                          className="quiet"
                          onClick={() =>
                            setSelectedDays(
                              allSelected ? new Set() : new Set(review.byDay.map((day) => day.day)),
                            )
                          }
                        >
                          {allSelected ? 'Deselect all' : 'Select all'}
                        </button>
                      </div>
                    </div>
                    <ul className="date-select-list">
                      {review.byDay.map((day) => {
                        const count = day.photos + day.videos + day.other;
                        const checked = selectedDays.has(day.day);
                        return (
                          <li key={day.day}>
                            <label className={checked ? 'is-selected' : ''}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleDay(day.day)}
                                aria-label={`Include ${formatDate(day.day)}`}
                              />
                              <span className="date-select-label">{formatDate(day.day)}</span>
                              <span className="date-select-meta">
                                {count.toLocaleString()} files · {formatBytes(day.bytes)}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                )}
                <div className="preview">
                  <span>Destination preview</span>
                  <CopyableValue
                    value={review.destinationPreview}
                    label="destination template preview"
                  />
                </div>
              </>
            )}
            {alert}
            <div className="actions">
              <button
                type="button"
                className="secondary"
                onClick={() => void chooseDestination()}
                disabled={busy}
              >
                {busy
                  ? 'Reviewing…'
                  : destination?.status === 'selected' || usingSettingsDestination
                    ? 'Change destination'
                    : 'Choose destination'}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void start()}
                disabled={startBlockedReason !== undefined}
                aria-describedby={
                  startBlockedReason === undefined ? undefined : 'start-ingest-reason'
                }
              >
                {startInFlight && (
                  <span className="spinner" aria-hidden="true" data-testid="start-ingest-spinner" />
                )}
                {startInFlight ? 'Starting…' : 'Start ingest'}
              </button>
              <button type="button" className="quiet" onClick={reset} disabled={busy}>
                Done
              </button>
            </div>
            {startBlockedReason !== undefined && (
              <p id="start-ingest-reason" className="field-hint" role="note">
                {startBlockedReason}
              </p>
            )}
          </section>
        </main>
      </>
    );
  }

  if (view === 'complete') {
    return (
      <>
        {navigation}
        <main className="shell">
          <section className="panel completion">
            <p className="eyebrow">INGEST / TERMINAL</p>
            <h1 ref={heading} tabIndex={-1}>
              Ingest complete
            </h1>
            <div className="metrics" aria-live="polite">
              <strong>{session?.completedFiles ?? 0} verified</strong>
              <strong>{session?.skippedFiles ?? 0} skipped</strong>
              <strong>{session?.failedFiles ?? 0} failed</strong>
            </div>
            {session !== undefined && <SessionFields session={session} />}
            {session !== undefined && <ErrorList session={session} />}
            <div className="actions">
              <button type="button" className="primary" onClick={() => setView('summary')}>
                View media summary
              </button>
              <button type="button" className="secondary" onClick={reset}>
                Done
              </button>
            </div>
          </section>
        </main>
      </>
    );
  }

  if (session?.status === 'failed' || session?.status === 'cancelled') {
    return (
      <>
        {navigation}
        <main className="shell">
          <section className="panel">
            <p className="eyebrow">INGEST / {session.phase.toUpperCase()}</p>
            <h1 ref={heading} tabIndex={-1}>
              {session.status === 'failed' ? 'Ingest failed' : 'Ingest cancelled'}
            </h1>
            <div className="metrics" aria-live="polite">
              <strong>{session.completedFiles} verified</strong>
              <strong>{session.skippedFiles} skipped</strong>
              <strong>{session.failedFiles} failed</strong>
            </div>
            <SessionFields session={session} />
            <ErrorList session={session} />
            <div className="actions">
              <button type="button" className="primary" onClick={retryReview}>
                Review folders again
              </button>
              <button type="button" className="secondary" onClick={reset}>
                Done
              </button>
            </div>
          </section>
        </main>
      </>
    );
  }

  const telemetry = calculateProgressTelemetry(
    session?.totalBytes ?? 0,
    session?.completedBytes ?? 0,
    session?.throughputBytesPerSecond ?? 0,
  );
  const progress = telemetry.percent;
  return (
    <>
      {navigation}
      <main className="shell">
        <section className="panel">
          <p className="eyebrow">INGEST / {(session?.phase ?? 'Starting').toUpperCase()}</p>
          <h1 ref={heading} tabIndex={-1}>
            Ingest in progress
          </h1>
          {session !== undefined && <SessionFields session={session} />}
          <div aria-live="polite" aria-atomic="true">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${String(progress)}%` }} />
            </div>
            <progress value={progress} max={100} aria-label="Overall ingest progress">
              {progress}%
            </progress>
            <p className="current-file">{session?.currentFile ?? 'Preparing files…'}</p>
            <div className="metrics">
              <strong>{session?.totalFiles ?? 0} total</strong>
              <strong>{session?.currentFile ?? '—'} current</strong>
              <strong>{session?.newFiles ?? 0} new</strong>
              <strong>{session?.skippedFiles ?? 0} skipped</strong>
              <strong>{session?.failedFiles ?? 0} failed</strong>
              <strong>{session?.verifiedFiles ?? session?.completedFiles ?? 0} verified</strong>
              <strong>
                {(session?.throughputBytesPerSecond ?? 0).toLocaleString('en-US')} B/s
              </strong>
              <strong>
                {telemetry.etaSeconds === null ? 'ETA —' : `ETA ${String(telemetry.etaSeconds)}s`}
              </strong>
            </div>
          </div>
          {session !== undefined && <ErrorList session={session} />}
          {alert}
          <button
            type="button"
            className="danger"
            onClick={() => void cancel()}
            disabled={busy || sessionId === undefined}
          >
            {busy ? 'Cancelling…' : 'Cancel ingest'}
          </button>
        </section>
      </main>
    </>
  );
}
