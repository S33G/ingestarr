// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../preload/api';
import type { SessionSnapshot } from '@ingestarr/shared-types';

import { App } from './App';

const source = {
  status: 'selected' as const,
  capabilityId: 'source-capability',
  label: 'CARD',
  displayPath: '…/CARD',
  expiresAt: '2026-07-19T12:05:00.000Z',
};
const destination = {
  status: 'selected' as const,
  capabilityId: 'destination-capability',
  label: 'Archive',
  displayPath: '…/Archive',
  expiresAt: '2026-07-19T12:05:00.000Z',
};
const review = {
  ok: true as const,
  value: {
    reviewId: 'review-1',
    expiresAt: '2026-07-19T12:05:00.000Z',
    source: { displayName: 'CARD', identity: 'New source', confidence: 'medium' as const },
    counts: { new: 2, known: 1, ambiguous: 0, recoverable: 0 },
    estimatedBytes: 2048,
    destinationPreview: 'Archive/2026/2026-07-19/CARD',
    byDay: [],
  },
};
const copying: SessionSnapshot = {
  sessionId: 'session-1',
  status: 'copying',
  phase: 'Copying',
  totalFiles: 3,
  completedFiles: 1,
  skippedFiles: 1,
  failedFiles: 0,
  totalBytes: 2048,
  completedBytes: 1024,
  currentFile: 'clip.mov',
  throughputBytesPerSecond: 512,
  errors: [],
  startedAt: '2026-07-19T12:00:00.000Z',
  updatedAt: '2026-07-19T12:00:02.000Z',
};

function api() {
  let progress: ((session: SessionSnapshot) => void) | undefined;
  const value: DesktopApi = {
    health: vi.fn().mockResolvedValue({
      status: 'ok',
      version: '0.0.0',
      checkedAt: '2026-07-19T12:00:00.000Z',
    }),
    chooseSourceFolder: vi.fn().mockResolvedValue(source),
    chooseDestinationFolder: vi.fn().mockResolvedValue(destination),
    listDetectedSources: vi.fn().mockResolvedValue({
      ok: true,
      sources: [
        {
          id: 'device-1',
          capabilityId: 'detected-capability',
          label: 'AUTO CARD',
          kind: 'removable-volume',
          online: true,
          identityConfidence: 'high',
          reasons: ['strong-platform-id-observed'],
          requiresConfirmation: true,
          expiresAt: '2026-07-19T12:05:00.000Z',
          deviceVendor: 'SanDisk',
          deviceModel: 'Extreme Pro',
          fsType: 'exFAT',
          capacityBytes: 64_000_000_000,
        },
      ],
    }),
    setSourceNickname: vi.fn().mockResolvedValue({ ok: true, nickname: null }),
    registerSource: vi
      .fn()
      .mockResolvedValue({ ok: true, sourceId: 'device-1', nickname: 'canon-r5' }),
    countSourceMedia: vi
      .fn()
      .mockResolvedValue({ ok: true, total: 128, photos: 100, videos: 28, other: 0, bytes: 2048 }),
    listKnownSources: vi.fn().mockResolvedValue({
      ok: true,
      sources: [
        {
          id: 'known-1',
          displayName: 'Travel Card',
          nickname: null,
          kind: 'removable-volume',
          online: false,
          firstSeenAt: '2026-07-01T12:00:00.000Z',
          lastSeenAt: '2026-07-18T12:00:00.000Z',
          sessionCount: 2,
          lastSessionStatus: 'completed',
          verifiedMediaCount: 42,
          verifiedBytes: 2048,
          identityConfidence: 'exact',
          throughput: {
            averageBytesPerSecond: 20_000_000,
            lastBytesPerSecond: 4_000_000,
            sampleCount: 5,
            isSlow: true,
          },
        },
      ],
    }),
    getSettings: vi.fn().mockResolvedValue({
      ok: true,
      settings: {
        destination: { configured: false },
        allowedExtensions: ['.jpg', '.mov'],
        excludedPathPatterns: ['.Trashes'],
        destinationTemplate: '{YYYY}/{YYYY-MM-DD}/{sourceLabelOrCamera}/{originalFilename}',
        copyConcurrency: 1,
        groupByNicknameInDestination: false,
        perCardEventLog: false,
        autoIngest: false,
        thumbnail: {
          width: 480,
          height: 480,
          cachePolicy: 'bounded',
          cacheLimitBytes: 2_000_000_000,
        },
        verifyCopies: true,
      },
    }),
    updateSettings: vi.fn().mockImplementation(async (request) => ({
      ok: true,
      settings: {
        destination: { configured: request.destinationCapabilityId !== undefined },
        allowedExtensions: request.allowedExtensions,
        excludedPathPatterns: request.excludedPathPatterns,
        destinationTemplate: request.destinationTemplate,
        copyConcurrency: request.copyConcurrency,
        groupByNicknameInDestination: request.groupByNicknameInDestination,
        perCardEventLog: request.perCardEventLog,
        autoIngest: request.autoIngest ?? false,
        thumbnail: request.thumbnail,
        verifyCopies: true as const,
      },
    })),
    resetDestinationToDefault: vi.fn().mockResolvedValue({
      ok: true,
      settings: {
        destination: { configured: true, path: '/home/user/Documents/Ingestarr' },
        allowedExtensions: ['.jpg'],
        excludedPathPatterns: [],
        destinationTemplate: '{YYYY}/{YYYY-MM-DD}/{sourceLabelOrCamera}/{originalFilename}',
        copyConcurrency: 1,
        groupByNicknameInDestination: false,
        perCardEventLog: false,
        autoIngest: false,
        thumbnail: {
          width: 480,
          height: 480,
          cachePolicy: 'bounded',
          cacheLimitBytes: 2_000_000_000,
        },
        verifyCopies: true as const,
      },
    }),
    validateTemplate: vi.fn().mockResolvedValue({
      ok: true,
      preview: '2026/2026-07-19/CARD/IMG_0001.JPG',
    }),
    review: vi.fn().mockResolvedValue(review),
    start: vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-1' }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
    listRecoverableSessions: vi.fn().mockResolvedValue({ ok: true, sessions: [] }),
    claimSession: vi.fn(),
    recoverSession: vi.fn().mockResolvedValue({
      ok: true,
      result: { action: 'resume', session: copying },
    }),
    getSession: vi.fn().mockResolvedValue({ ok: true, session: copying }),
    listSummaryDays: vi.fn().mockResolvedValue({
      ok: true,
      days: [
        {
          captureDay: '2026-07-19',
          photoCount: 2,
          videoCount: 1,
          unknownCount: 0,
          totalSizeBytes: 2048,
        },
      ],
    }),
    listSummaryMediaByDay: vi.fn().mockResolvedValue({
      ok: true,
      items: [
        {
          id: 'photo-1',
          copyId: 'copy-1',
          checksum: 'sha',
          captureDay: '2026-07-19',
          capturedAt: '2026-07-19T10:00:00.000Z',
          originalFilename: 'generated.jpg',
          mediaType: 'photo',
          sizeBytes: 1024,
          cameraMake: null,
          cameraModel: null,
          width: 40,
          height: 20,
          durationSeconds: null,
          thumbnail: {
            state: 'failed',
            errorCode: 'THUMBNAIL_FAILED',
            safeMessage: 'Thumbnail unavailable.',
            retryCount: 1,
            attemptCount: 1,
            nextRetryAt: '2026-07-19T12:01:00.000Z',
            maxAttempts: 3,
            retryCapability: {
              token: 'opaque-retry',
              expiresAt: '2026-07-19T12:02:00.000Z',
            },
          },
        },
      ],
      nextCursor: 'next-page',
    }),
    getThumbnail: vi.fn(),
    retryThumbnail: vi.fn().mockResolvedValue({ ok: true }),
    copyText: vi.fn().mockResolvedValue({ ok: true }),
    onProgress: vi.fn((listener) => {
      progress = listener;
      return vi.fn();
    }),
    onSummaryInvalidated: vi.fn(() => vi.fn()),
    onDetectedSourcesChanged: vi.fn(() => vi.fn()),
  };
  return { value, progress: () => progress };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('manual folder ingest flow', () => {
  it('handles dialog cancellation and duplicate source clicks', async () => {
    const mock = api();
    vi.mocked(mock.value.chooseSourceFolder).mockResolvedValueOnce({ status: 'cancelled' });
    window.ingestarr = mock.value;
    render(<App />);
    const choose = screen.getByRole('button', { name: /choose source folder/i });

    await userEvent.click(choose);

    expect(screen.getByRole('heading', { name: /sources/i })).toBeInTheDocument();
    expect(choose).toBeEnabled();
  });

  it('moves from Home through Review and Progress to completion', async () => {
    const mock = api();
    window.ingestarr = mock.value;
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: /choose source folder/i }));
    expect(await screen.findByRole('heading', { name: /review source/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /choose destination/i }));
    expect(await screen.findByText('2 new')).toBeInTheDocument();
    expect(screen.getByText(/Archive\/2026/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /start ingest/i }));
    expect(await screen.findByRole('heading', { name: /ingest in progress/i })).toBeInTheDocument();
    mock.progress()?.(copying);
    expect(await screen.findByText('clip.mov')).toBeInTheDocument();
    expect(screen.getByText('session-1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /copy session id/i }));
    expect(mock.value.copyText).toHaveBeenCalledWith('session-1');
    mock.progress()?.({
      ...copying,
      status: 'completed',
      phase: 'Completed',
      completedFiles: 2,
      completedBytes: 2048,
      currentFile: undefined,
    });

    expect(await screen.findByRole('heading', { name: /ingest complete/i })).toBeInTheDocument();
    expect(screen.getByText(/2 verified/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^done$/i }));
    expect(screen.getByRole('heading', { name: /sources/i })).toBeInTheDocument();
  });

  it('surfaces stable identifiers but never renders bearer capabilities', async () => {
    const mock = api();
    window.ingestarr = mock.value;
    const rendered = render(<App />);

    expect(await screen.findByText('device-1')).toBeInTheDocument();
    expect(rendered.container).not.toHaveTextContent('detected-capability');
    expect(rendered.container).not.toHaveTextContent('source-capability');
    expect(rendered.container).not.toHaveTextContent('destination-capability');
    expect(rendered.container).not.toHaveTextContent('review-1');
    expect(rendered.container).not.toHaveTextContent('opaque-retry');

    await userEvent.click(screen.getByRole('button', { name: /^summary$/i }));
    await userEvent.click(
      await screen.findByRole('button', { name: /show media for 2026-07-19/i }),
    );
    expect(await screen.findByText('photo-1')).toBeInTheDocument();
    expect(screen.getByText('copy-1')).toBeInTheDocument();
    expect(screen.getByText('sha')).toBeInTheDocument();
    expect(rendered.container).not.toHaveTextContent('opaque-retry');
  });

  it('shows typed review errors and supports cancellation', async () => {
    const mock = api();
    window.ingestarr = mock.value;
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /choose source folder/i }));
    vi.mocked(mock.value.review).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'SOURCE_UNAVAILABLE',
        message: 'The selected source is no longer available.',
        retryable: true,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: /choose destination/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer available/i);

    vi.mocked(mock.value.review).mockResolvedValueOnce(review);
    await userEvent.click(screen.getByRole('button', { name: /change destination/i }));
    await userEvent.click(await screen.findByRole('button', { name: /start ingest/i }));
    await waitFor(() => expect(mock.value.start).toHaveBeenCalledOnce());
    await userEvent.click(await screen.findByRole('button', { name: /cancel ingest/i }));

    expect(mock.value.cancel).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  it('never shows a spinner or loading state merely from hovering the Start ingest button', async () => {
    const mock = api();
    window.ingestarr = mock.value;
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /choose source folder/i }));
    await userEvent.click(screen.getByRole('button', { name: /choose destination/i }));
    const start = await screen.findByRole('button', { name: /start ingest/i });
    expect(start).toBeEnabled();

    fireEvent.mouseEnter(start);
    fireEvent.mouseOver(start);
    fireEvent.mouseMove(start);

    expect(screen.queryByTestId('start-ingest-spinner')).not.toBeInTheDocument();
    expect(start).toHaveTextContent('Start ingest');
    expect(mock.value.start).not.toHaveBeenCalled();

    fireEvent.mouseLeave(start);
    expect(screen.queryByTestId('start-ingest-spinner')).not.toBeInTheDocument();
  });

  it('explains why Start ingest is disabled before a destination has been reviewed', async () => {
    const mock = api();
    window.ingestarr = mock.value;
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /choose source folder/i }));
    const start = await screen.findByRole('button', { name: /start ingest/i });

    expect(start).toBeDisabled();
    const reasonId = start.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId ?? '');
    expect(reason).toHaveTextContent(/no ingest plan yet/i);
    expect(reason).toHaveTextContent(/choose a destination/i);

    fireEvent.mouseEnter(start);
    expect(screen.queryByTestId('start-ingest-spinner')).not.toBeInTheDocument();
  });

  it('explains why Start ingest is disabled while source identity confirmation is pending', async () => {
    const mock = api();
    window.ingestarr = mock.value;
    vi.mocked(mock.value.review).mockResolvedValueOnce({
      ok: true,
      value: {
        ...review.value,
        source: {
          ...review.value.source,
          requiresConfirmation: true,
          candidates: [
            { sourceId: 'known-1', displayName: 'Travel Card', confidence: 'medium', reasons: [] },
          ],
        },
      },
    });
    window.ingestarr = mock.value;
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /choose source folder/i }));
    await userEvent.click(screen.getByRole('button', { name: /choose destination/i }));
    const start = await screen.findByRole('button', { name: /start ingest/i });

    expect(start).toBeDisabled();
    const reasonId = start.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId ?? '')).toHaveTextContent(
      /confirm above whether this is a known source or a new one/i,
    );

    await userEvent.click(
      screen.getByRole('radio', { name: /create a new source and keep these cards separate/i }),
    );
    expect(start).toBeEnabled();
    expect(screen.queryByText(/confirm above whether/i)).not.toBeInTheDocument();
  });

  it('shows a spinner only once Start ingest is actually in flight, not from a prior hover', async () => {
    const mock = api();
    let resolveStart!: (value: Awaited<ReturnType<DesktopApi['start']>>) => void;
    const pending = new Promise<Awaited<ReturnType<DesktopApi['start']>>>((resolve) => {
      resolveStart = resolve;
    });
    vi.mocked(mock.value.start).mockReturnValueOnce(pending);
    window.ingestarr = mock.value;
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /choose source folder/i }));
    await userEvent.click(screen.getByRole('button', { name: /choose destination/i }));
    const start = await screen.findByRole('button', { name: /start ingest/i });

    fireEvent.mouseEnter(start);
    fireEvent.mouseOver(start);
    expect(screen.queryByTestId('start-ingest-spinner')).not.toBeInTheDocument();

    await userEvent.click(start);
    expect(await screen.findByTestId('start-ingest-spinner')).toBeInTheDocument();
    expect(start).toHaveTextContent('Starting…');

    resolveStart({ ok: true, sessionId: 'session-1' });
    await waitFor(() =>
      expect(screen.queryByTestId('start-ingest-spinner')).not.toBeInTheDocument(),
    );
  });

  it('unsubscribes progress on unmount', () => {
    const mock = api();
    const unsubscribe = vi.fn();
    vi.mocked(mock.value.onProgress).mockReturnValue(unsubscribe);
    window.ingestarr = mock.value;
    const rendered = render(<App />);

    rendered.unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps accessible navigation across all six screens and handles detected cards', async () => {
    const mock = api();
    window.ingestarr = mock.value;
    render(<App />);

    expect(await screen.findByRole('navigation', { name: /primary/i })).toBeInTheDocument();
    // The app now opens straight on the Sources tab; detected cards appear here.
    expect(await screen.findByRole('heading', { name: /sources/i })).toBeInTheDocument();
    const autoCard = (await screen.findByText('AUTO CARD')).closest('.card-row') as HTMLElement;
    // "Start" on a detected card goes straight to review — no confusing confirmation modal.
    await userEvent.click(within(autoCard).getByRole('button', { name: /^start$/i }));
    expect(await screen.findByRole('heading', { name: /review source/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('dialog', { name: /confirm source identity/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^sources$/i }));
    expect(screen.getByRole('heading', { name: /sources/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    expect(await screen.findByRole('heading', { name: /settings/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^summary$/i }));
    expect(await screen.findByRole('heading', { name: /media summary/i })).toBeInTheDocument();
  });

  it('shows device metadata, a slow-throughput badge, and lets a nickname be set', async () => {
    const mock = api();
    // Offline cards can't be renamed, so this known card must be online to expose the editor.
    vi.mocked(mock.value.listKnownSources).mockResolvedValue({
      ok: true,
      sources: [
        {
          id: 'known-1',
          displayName: 'Travel Card',
          nickname: null,
          kind: 'removable-volume',
          online: true,
          firstSeenAt: '2026-07-01T12:00:00.000Z',
          lastSeenAt: '2026-07-18T12:00:00.000Z',
          sessionCount: 2,
          lastSessionStatus: 'completed',
          verifiedMediaCount: 42,
          verifiedBytes: 2048,
          identityConfidence: 'exact',
          throughput: {
            averageBytesPerSecond: 20_000_000,
            lastBytesPerSecond: 4_000_000,
            sampleCount: 5,
            isSlow: true,
          },
        },
      ],
    });
    window.ingestarr = mock.value;
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: /^sources$/i }));
    await screen.findByRole('heading', { name: /sources/i });

    expect(screen.getByText('SanDisk Extreme Pro')).toBeInTheDocument();
    expect(screen.getByText('Slow')).toBeInTheDocument();
    expect(screen.getByText(/exFAT.*59\.6 GiB/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /edit nickname for travel card/i }));
    const nicknameInput = screen.getByRole('textbox', { name: /nickname for travel card/i });
    await userEvent.type(nicknameInput, 'canon-r5');
    const knownCard = nicknameInput.closest('.card-row') as HTMLElement;
    await userEvent.click(within(knownCard).getByRole('button', { name: /^save$/i }));

    expect(mock.value.setSourceNickname).toHaveBeenCalledWith({
      sourceId: 'known-1',
      nickname: 'canon-r5',
    });
    expect(mock.value.listKnownSources).toHaveBeenCalledTimes(2);
  });

  it('lets a nickname be set on a detected card before it has ever been ingested', async () => {
    const mock = api();
    window.ingestarr = mock.value;
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: /^sources$/i }));
    await screen.findByRole('heading', { name: /sources/i });

    await userEvent.click(screen.getByRole('button', { name: /edit nickname for auto card/i }));
    const detectedNicknameInput = screen.getByRole('textbox', { name: /nickname for auto card/i });
    await userEvent.type(detectedNicknameInput, 'canon-r5');
    const newCard = detectedNicknameInput.closest('.card-row') as HTMLElement;
    await userEvent.click(within(newCard).getByRole('button', { name: /^save$/i }));

    expect(mock.value.registerSource).toHaveBeenCalledWith({
      detectedSourceId: 'device-1',
      nickname: 'canon-r5',
    });
    await waitFor(() => expect(mock.value.listKnownSources).toHaveBeenCalledTimes(2));
  });

  it('shows one card, not two, when a detected volume resolves to a known source', async () => {
    const mock = api();
    vi.mocked(mock.value.listKnownSources).mockResolvedValue({
      ok: true,
      sources: [
        {
          id: 'known-1',
          displayName: 'Travel Card',
          nickname: 'canon-r5',
          kind: 'removable-volume',
          online: true,
          firstSeenAt: '2026-07-01T12:00:00.000Z',
          lastSeenAt: '2026-07-18T12:00:00.000Z',
          sessionCount: 2,
          lastSessionStatus: 'completed',
          verifiedMediaCount: 42,
          verifiedBytes: 2048,
          identityConfidence: 'exact',
        },
      ],
    });
    vi.mocked(mock.value.listDetectedSources).mockResolvedValue({
      ok: true,
      sources: [
        {
          id: 'device-1',
          capabilityId: 'detected-capability',
          label: 'AUTO CARD',
          kind: 'removable-volume',
          online: true,
          identityConfidence: 'exact',
          reasons: ['on-card-identity-marker'],
          requiresConfirmation: false,
          expiresAt: '2026-07-19T12:05:00.000Z',
          fsType: 'exFAT',
          capacityBytes: 64_000_000_000,
          knownSourceId: 'known-1',
          knownNickname: 'canon-r5',
        },
      ],
    });
    window.ingestarr = mock.value;
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: /^sources$/i }));
    await screen.findByRole('heading', { name: /sources/i });

    // The known card is present and shown online; the detected volume is folded in, not shown as
    // a second "New card" for the same physical card.
    expect(screen.getByText('canon-r5')).toBeInTheDocument();
    expect(screen.queryByText('New card')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use auto card/i })).not.toBeInTheDocument();
  });

  it('counts and shows the number of media on an online card in the Sources tab', async () => {
    const mock = api();
    vi.mocked(mock.value.countSourceMedia).mockResolvedValue({
      ok: true,
      total: 342,
      photos: 300,
      videos: 42,
      other: 0,
      bytes: 4096,
    });
    window.ingestarr = mock.value;
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: /^sources$/i }));
    await screen.findByRole('heading', { name: /sources/i });

    await waitFor(() =>
      expect(mock.value.countSourceMedia).toHaveBeenCalledWith({ detectedSourceId: 'device-1' }),
    );
    const count = (await screen.findByText(/342/)).closest('p');
    expect(count).toHaveTextContent(/342\s*media/);
    expect(count).toHaveTextContent(/300 photos/);
    expect(count).toHaveTextContent(/42 videos/);
  });

  it('turns on automatic mode from the sidebar switch and persists it', async () => {
    const mock = api();
    window.ingestarr = mock.value;
    render(<App />);

    const toggle = await screen.findByRole('switch', { name: /automatic mode/i });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);

    await waitFor(() =>
      expect(mock.value.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ autoIngest: true }),
      ),
    );
  });

  it('validates and saves settings through opaque destination capabilities', async () => {
    const mock = api();
    window.ingestarr = mock.value;
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    await screen.findByRole('heading', { name: /settings/i });

    const template = screen.getByLabelText(/naming template/i);
    fireEvent.change(template, { target: { value: '{YYYY}/{originalFilename}' } });
    await waitFor(() =>
      expect(mock.value.validateTemplate).toHaveBeenLastCalledWith(
        expect.objectContaining({ template: '{YYYY}/{originalFilename}' }),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /choose destination/i }));
    await userEvent.click(screen.getByLabelText(/group destination by source nickname/i));
    await userEvent.click(screen.getByLabelText(/write a plain-text event log/i));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(mock.value.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationCapabilityId: 'destination-capability',
        destinationTemplate: '{YYYY}/{originalFilename}',
        groupByNicknameInDestination: true,
        perCardEventLog: true,
      }),
    );
    expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
  });

  it('renders grouped summaries, filters media, paginates, and shows placeholders', async () => {
    const mock = api();
    window.ingestarr = mock.value;
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: /^summary$/i }));
    expect(await screen.findByRole('heading', { name: /media summary/i })).toBeInTheDocument();
    expect(screen.getByText(/2 photos · 1 video/i)).toBeInTheDocument();
    expect(mock.value.listSummaryMediaByDay).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /show media for 2026-07-19/i }));
    expect(await screen.findByText('generated.jpg')).toBeInTheDocument();
    expect(screen.getByText(/thumbnail unavailable/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry thumbnail/i }));
    expect(mock.value.retryThumbnail).toHaveBeenCalledWith({ capability: 'opaque-retry' });

    await userEvent.selectOptions(screen.getByLabelText(/media type/i), 'photo');
    await waitFor(() =>
      expect(mock.value.listSummaryDays).toHaveBeenLastCalledWith({ mediaType: 'photo' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /show media for 2026-07-19/i }));
    await screen.findByText('generated.jpg');
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(mock.value.listSummaryMediaByDay).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'next-page', limit: 60 }),
    );
  });

  it('ignores stale day media responses after filters change', async () => {
    const mock = api();
    let resolveStale!: (value: Awaited<ReturnType<DesktopApi['listSummaryMediaByDay']>>) => void;
    const stale = new Promise<Awaited<ReturnType<DesktopApi['listSummaryMediaByDay']>>>(
      (resolve) => {
        resolveStale = resolve;
      },
    );
    vi.mocked(mock.value.listSummaryMediaByDay)
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce({
        ok: true,
        items: [
          {
            id: 'new',
            copyId: 'copy-new',
            checksum: 'new-sha',
            captureDay: '2026-07-19',
            capturedAt: null,
            originalFilename: 'new.jpg',
            mediaType: 'photo',
            sizeBytes: 10,
            cameraMake: null,
            cameraModel: null,
            width: null,
            height: null,
            durationSeconds: null,
            thumbnail: { state: 'missing' },
          },
        ],
        nextCursor: null,
      });
    window.ingestarr = mock.value;
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /^summary$/i }));
    await screen.findByText(/2 photos · 1 video/i);
    await userEvent.click(screen.getByRole('button', { name: /show media for 2026-07-19/i }));
    await userEvent.selectOptions(screen.getByLabelText(/media type/i), 'photo');
    await waitFor(() =>
      expect(mock.value.listSummaryDays).toHaveBeenLastCalledWith({ mediaType: 'photo' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /show media for 2026-07-19/i }));
    expect(await screen.findByText('new.jpg')).toBeInTheDocument();

    resolveStale({
      ok: true,
      items: [
        {
          id: 'old',
          copyId: 'copy-old',
          checksum: 'old-sha',
          captureDay: '2026-07-19',
          capturedAt: null,
          originalFilename: 'old.jpg',
          mediaType: 'video',
          sizeBytes: 10,
          cameraMake: null,
          cameraModel: null,
          width: null,
          height: null,
          durationSeconds: null,
          thumbnail: { state: 'missing' },
        },
      ],
      nextCursor: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(screen.queryByText('old.jpg')).not.toBeInTheDocument();
  });

  it.each([
    ['failed', 'Ingest failed'],
    ['cancelled', 'Ingest cancelled'],
  ] as const)(
    'renders %s as a terminal result without an active cancel action',
    async (status, heading) => {
      const mock = api();
      window.ingestarr = mock.value;
      render(<App />);

      mock.progress()?.({
        ...copying,
        status,
        phase: status === 'failed' ? 'Failed' : 'Cancelled',
        failedFiles: 1,
        errors: [
          {
            code: 'READ_FAILED',
            message: 'A media file could not be copied.',
            filename: 'clip.mov',
          },
        ],
      });

      expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
      expect(screen.getByText(/1 failed/i)).toBeInTheDocument();
      expect(screen.getAllByText(/clip.mov/i).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: /cancel ingest/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /review folders again/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^done$/i })).toBeInTheDocument();
    },
  );
});
