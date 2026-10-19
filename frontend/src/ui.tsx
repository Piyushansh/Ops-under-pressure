import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { navigate } from './ctx';
import type { Item, Priority, Status } from './types';

export const label = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
export const isOverdue = (item: Item) =>
  !!item.dueDate && new Date(item.dueDate) < new Date() && item.status !== 'RESOLVED' && item.status !== 'CLOSED';

/** Loads data and keeps the previous result visible while a reload is in flight. Ignores out-of-order responses. */
export function useFetch<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    const id = ++seq.current;
    setState((s) => ({ data: s.data, loading: true }));
    fn()
      .then((data) => id === seq.current && setState({ data, loading: false }))
      .catch((e) => id === seq.current && setState({ error: e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e)), loading: false }));
  }, deps);
  useEffect(() => run(), [run]);
  return { ...state, reload: run, setData: (data: T) => setState({ data, loading: false }) };
}

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge status-${status}`}>{label(status)}</span>;
}
export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`badge prio-${priority}`}>{label(priority)}</span>;
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden /> {text}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint && <p>{hint}</p>}
    </div>
  );
}

/** One place that turns API failures into clear, distinct messages. */
export function ErrorBanner({ error, onRetry }: { error: ApiError | null | undefined; onRetry?: () => void }) {
  if (!error) return null;
  let kind = 'error';
  let title = 'Something went wrong';
  if (error.status === 403) { kind = 'warn'; title = 'Permission denied'; }
  else if (error.status === 404) { kind = 'warn'; title = 'Not found'; }
  else if (error.status === 409) { kind = 'warn'; title = 'Conflict'; }
  else if (error.status === 400) { kind = 'warn'; title = 'Please check your input'; }
  else if (error.status === 0) { title = 'Network problem'; }
  const retryable = error.status === 0 || error.status >= 500;
  return (
    <div className={`banner banner-${kind}`} role="alert">
      <div>
        <strong>{title}.</strong> {error.message}
      </div>
      {retryable && onRetry && (
        <button className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function ItemRows({ items, empty }: { items: Item[]; empty: string }) {
  if (items.length === 0) return <Empty title={empty} />;
  return (
    <ul className="rows">
      {items.map((i) => (
        <li key={i.id}>
          <button className="row" onClick={() => navigate(`/items/${i.id}`)}>
            <span className="row-title">{i.title}</span>
            <span className="row-meta">
              <PriorityBadge priority={i.priority} />
              <StatusBadge status={i.status} />
              <span className="muted">{i.team.name}</span>
              {i.dueDate && <span className={isOverdue(i) ? 'overdue' : 'muted'}>Due {fmtDate(i.dueDate)}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
