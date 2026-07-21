import { useEffect, useRef, useState } from 'react';

import type { SummaryDay, SummaryMedia } from '@ingestarr/shared-types';
import { CopyableValue, exactBytes, Field, FieldList } from './util-ui';

interface DayPage {
  items: SummaryMedia[];
  nextCursor: string | null;
  loading: boolean;
  error?: string;
}

function formatBytes(bytes: number): string {
  return exactBytes(bytes);
}

function countLabel(day: SummaryDay): string {
  const photos = `${String(day.photoCount)} photo${day.photoCount === 1 ? '' : 's'}`;
  const videos = `${String(day.videoCount)} video${day.videoCount === 1 ? '' : 's'}`;
  return `${photos} · ${videos} · ${formatBytes(day.totalSizeBytes)}`;
}

function Thumbnail({ media }: { media: SummaryMedia }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    if (media.thumbnail.state !== 'ready') return;
    void window.ingestarr.getThumbnail(media.thumbnail.token).then((response) => {
      if (active && response.ok) {
        setUrl(`data:${response.mimeType};base64,${response.base64}`);
      }
    });
    return () => {
      active = false;
    };
  }, [media]);
  if (media.thumbnail.state !== 'ready' || url === undefined) {
    return (
      <div
        className="thumbnail-placeholder"
        role="img"
        aria-label={`${media.originalFilename} thumbnail unavailable`}
      >
        <span>
          {media.thumbnail.state === 'failed'
            ? media.thumbnail.safeMessage
            : media.thumbnail.state === 'ready'
              ? 'Loading thumbnail…'
              : 'Thumbnail pending'}
        </span>
      </div>
    );
  }
  return <img loading="lazy" src={url} alt={`${media.originalFilename} thumbnail`} />;
}

export function SummaryScreen({
  headingRef,
  onBack,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onBack(): void;
}) {
  const [days, setDays] = useState<SummaryDay[]>([]);
  const [pages, setPages] = useState<Record<string, DayPage>>({});
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());
  const [mediaType, setMediaType] = useState<'' | 'photo' | 'video' | 'unknown'>('');
  const [sourceId, setSourceId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [retryNonce, setRetryNonce] = useState(0);
  const requestGeneration = useRef(0);
  const dayControllers = useRef(new Map<string, AbortController>());
  const daysController = useRef<AbortController | undefined>(undefined);
  const filters = {
    ...(mediaType === '' ? {} : { mediaType }),
    ...(sourceId.trim() === '' ? {} : { sourceId: sourceId.trim() }),
  };

  useEffect(
    () => window.ingestarr.onSummaryInvalidated(() => setRetryNonce((value) => value + 1)),
    [],
  );

  const loadPage = async (day: string, cursor?: string): Promise<void> => {
    const generation = requestGeneration.current;
    const controller = new AbortController();
    dayControllers.current.get(day)?.abort();
    dayControllers.current.set(day, controller);
    setPages((current) => ({
      ...current,
      [day]: {
        items: current[day]?.items ?? [],
        nextCursor: current[day]?.nextCursor ?? null,
        loading: true,
      },
    }));
    try {
      const response = await window.ingestarr.listSummaryMediaByDay({
        ...filters,
        captureDay: day,
        limit: 60,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (controller.signal.aborted || requestGeneration.current !== generation) return;
      if (!response.ok) throw new Error(response.error.message);
      setPages((current) => ({
        ...current,
        [day]: {
          items:
            cursor === undefined
              ? response.items
              : [...(current[day]?.items ?? []), ...response.items],
          nextCursor: response.nextCursor,
          loading: false,
        },
      }));
    } catch {
      if (controller.signal.aborted || requestGeneration.current !== generation) return;
      setPages((current) => ({
        ...current,
        [day]: {
          items: current[day]?.items ?? [],
          nextCursor: current[day]?.nextCursor ?? null,
          loading: false,
          error: 'Media for this day could not be loaded.',
        },
      }));
    }
  };

  useEffect(() => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    daysController.current?.abort();
    for (const controller of dayControllers.current.values()) controller.abort();
    dayControllers.current.clear();
    const controller = new AbortController();
    daysController.current = controller;
    setLoading(true);
    setError(undefined);
    setPages({});
    setExpandedDays(new Set());
    void window.ingestarr
      .listSummaryDays(filters)
      .then((response) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        if (!response.ok) throw new Error(response.error.message);
        setDays(response.days);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        setError('The media summary could not be loaded.');
        setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [mediaType, sourceId, retryNonce]);

  return (
    <main className="summary-shell">
      <header className="summary-header">
        <div>
          <p className="eyebrow">MEDIA INDEX / VERIFIED</p>
          <h1 ref={headingRef} tabIndex={-1}>
            Media summary
          </h1>
        </div>
        <button type="button" className="secondary" onClick={onBack}>
          Back home
        </button>
      </header>
      <form className="summary-filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          Media type
          <select
            value={mediaType}
            onChange={(event) => setMediaType(event.target.value as typeof mediaType)}
          >
            <option value="">All media</option>
            <option value="photo">Photos</option>
            <option value="video">Videos</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Source
          <input
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
            placeholder="All sources"
          />
        </label>
      </form>
      <p className="summary-status" aria-live="polite">
        {loading ? 'Loading summary…' : (error ?? `${String(days.length)} date groups`)}
      </p>
      {error !== undefined && (
        <button
          type="button"
          className="secondary"
          onClick={() => setRetryNonce((value) => value + 1)}
        >
          Retry summary
        </button>
      )}
      {!loading && error === undefined && days.length === 0 && (
        <section className="summary-empty">
          <h2>No verified media yet</h2>
          <p>Complete an ingest to see date-grouped photos and videos.</p>
        </section>
      )}
      {days.map((day) => {
        const page = pages[day.captureDay];
        const expanded = expandedDays.has(day.captureDay);
        return (
          <section
            className="day-section"
            key={day.captureDay}
            aria-labelledby={`day-${day.captureDay}`}
          >
            <div className="day-heading">
              <div>
                <h2 id={`day-${day.captureDay}`}>{day.captureDay}</h2>
                <p>{countLabel(day)}</p>
              </div>
              <button
                type="button"
                className="secondary"
                aria-expanded={expanded}
                aria-controls={`media-${day.captureDay}`}
                aria-label={`${expanded ? 'Hide' : 'Show'} media for ${day.captureDay}`}
                onClick={() => {
                  setExpandedDays((current) => {
                    const next = new Set(current);
                    if (expanded) next.delete(day.captureDay);
                    else next.add(day.captureDay);
                    return next;
                  });
                  if (!expanded && page === undefined) void loadPage(day.captureDay);
                }}
              >
                {expanded ? 'Hide media' : 'Show media'}
              </button>
            </div>
            {expanded && (
              <div id={`media-${day.captureDay}`}>
                {page?.error !== undefined && (
                  <>
                    <p role="alert">{page.error}</p>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void loadPage(day.captureDay)}
                    >
                      Retry day
                    </button>
                  </>
                )}
                <div className="media-grid">
                  {(page?.items ?? []).map((media) => {
                    const failedThumbnail =
                      media.thumbnail.state === 'failed' ? media.thumbnail : undefined;
                    return (
                      <article className="media-card" key={media.id}>
                        <Thumbnail media={media} />
                        <div className="media-data">
                          <strong title={media.originalFilename}>{media.originalFilename}</strong>
                          <FieldList>
                            <Field label="Media ID">
                              <CopyableValue value={media.id} label="media ID" />
                            </Field>
                            <Field label="Copy ID">
                              <CopyableValue value={media.copyId} label="copy ID" />
                            </Field>
                            <Field label="Checksum">
                              <CopyableValue value={media.checksum} label="checksum" />
                            </Field>
                            <Field label="Capture day">
                              <code>{media.captureDay}</code>
                            </Field>
                            <Field label="Captured at">
                              <code>{media.capturedAt ?? 'null'}</code>
                            </Field>
                            <Field label="Media type">
                              <code>{media.mediaType}</code>
                            </Field>
                            <Field label="Camera">
                              <code>
                                {media.cameraMake ?? '—'} / {media.cameraModel ?? '—'}
                              </code>
                            </Field>
                            <Field label="Dimensions">
                              <code>
                                {media.width ?? '—'} × {media.height ?? '—'}
                              </code>
                            </Field>
                            <Field label="Duration">
                              <code>
                                {media.durationSeconds === null
                                  ? '—'
                                  : `${String(media.durationSeconds)} s`}
                              </code>
                            </Field>
                            <Field label="Size">{formatBytes(media.sizeBytes)}</Field>
                            <Field label="Thumbnail">
                              <code>
                                {media.thumbnail.state}
                                {failedThumbnail === undefined
                                  ? ''
                                  : ` / ${failedThumbnail.errorCode}`}
                              </code>
                            </Field>
                          </FieldList>
                          {failedThumbnail !== undefined &&
                            failedThumbnail.attemptCount < failedThumbnail.maxAttempts && (
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => {
                                  void window.ingestarr
                                    .retryThumbnail({
                                      capability: failedThumbnail.retryCapability.token,
                                    })
                                    .then((response) => {
                                      if (response.ok) setRetryNonce((value) => value + 1);
                                    });
                                }}
                              >
                                Retry thumbnail
                              </button>
                            )}
                        </div>
                      </article>
                    );
                  })}
                </div>
                {page?.loading === true && <p aria-live="polite">Loading media…</p>}
                {page?.nextCursor !== null && page?.nextCursor !== undefined && (
                  <button
                    type="button"
                    className="secondary load-more"
                    disabled={page.loading}
                    onClick={() => void loadPage(day.captureDay, page.nextCursor ?? undefined)}
                  >
                    Load more
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}
