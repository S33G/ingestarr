import { useEffect, useState, type ReactNode } from 'react';

export function CopyableValue({
  value,
  label,
  className = '',
  wrap = false,
}: {
  value: string;
  label: string;
  className?: string;
  /** When true the value wraps onto multiple lines instead of truncating with an ellipsis. */
  wrap?: boolean;
}) {
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (status === '') return;
    const timer = window.setTimeout(() => setStatus(''), 1_500);
    return () => window.clearTimeout(timer);
  }, [status]);

  return (
    <span className={`copyable ${className}`.trim()}>
      <code className={`copyable-value${wrap ? ' is-wrap' : ''}`} title={value}>
        {value}
      </code>
      <button
        type="button"
        className="copy-button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void window.ingestarr.copyText(value).then((response) => {
            if (response.ok) setStatus('Copied');
          });
        }}
      >
        Copy
      </button>
      <span className="copy-status" role="status" aria-live="polite">
        {status}
      </span>
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function FieldList({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <dl className="field-list" aria-label={label}>
      {children}
    </dl>
  );
}

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const dayFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

// Turns an ISO timestamp into a human, locale-aware date + time. Falls back to the
// raw string if it can't be parsed, so a bad value is never hidden entirely.
export function formatDateTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : dateTimeFormatter.format(parsed);
}

export function formatDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : dateFormatter.format(parsed);
}

// Formats a capture-day (YYYY-MM-DD) compactly for a capacity-bar legend. Parsed as
// local time (noon) to avoid the value slipping to the previous day across time zones.
export function formatDayLabel(day: string): string {
  const parsed = new Date(`${day}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? day : dayFormatter.format(parsed);
}

export function exactBytes(bytes: number): string {
  const human =
    bytes < 1_024
      ? `${String(bytes)} B`
      : bytes < 1_024 ** 2
        ? `${(bytes / 1_024).toFixed(1)} KiB`
        : bytes < 1_024 ** 3
          ? `${(bytes / 1_024 ** 2).toFixed(1)} MiB`
          : `${(bytes / 1_024 ** 3).toFixed(1)} GiB`;
  return `${human} (${bytes.toLocaleString('en-US')} B)`;
}
