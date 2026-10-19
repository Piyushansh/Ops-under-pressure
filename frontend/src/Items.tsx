import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, ApiError, qs } from './api';
import { navigate, useApp } from './ctx';
import { ITEM_TYPES, PRIORITIES, STATUSES, type Item, type Paged } from './types';
import { ErrorBanner, ItemRows, label, Loading, useFetch } from './ui';

function NewItemForm({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const { memberships } = useApp();
  const teams = memberships.filter((m) => m.role !== 'VIEWER');
  const [f, setF] = useState({ title: '', description: '', type: 'TASK', priority: 'MEDIUM', teamId: teams[0]?.teamId ?? '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per form submission attempt: a retry after a timeout reuses it, so no duplicate item.
  const key = useRef(crypto.randomUUID());

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const item = await api<Item>('POST', '/api/items', f, { 'Idempotency-Key': key.current });
      onDone(item.id);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }
  const fe = error?.fieldErrors ?? {};
  if (teams.length === 0) return <div className="banner banner-warn">Viewers cannot create items.</div>;
  return (
    <form className="card form" onSubmit={submit} noValidate>
      <h2>New work item</h2>
      {error && !Object.keys(fe).length && <ErrorBanner error={error} />}
      <label>Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} autoFocus />
        {fe.title && <span className="field-error">{fe.title}</span>}</label>
      <label>Description<textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <div className="form-row">
        <label>Team<select value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>
          {teams.map((t) => <option key={t.teamId} value={t.teamId}>{t.teamName}</option>)}</select></label>
        <label>Type<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          {ITEM_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></label>
        <label>Priority<select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
          {PRIORITIES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></label>
      </div>
      <div className="actions">
        <button className="btn btn-primary" disabled={busy || !f.title.trim()}>{busy ? 'Creating…' : 'Create'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function Items() {
  const { teams } = useApp();
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [assignee, setAssignee] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(1), [debouncedQ, status, priority, assignee]);

  const { data, error, loading, reload } = useFetch(
    () => api<Paged<Item>>('GET', `/api/items${qs({ q: debouncedQ, status, priority, assigneeId: assignee, page, pageSize: 15 })}`),
    [debouncedQ, status, priority, assignee, page],
  );
  const people = Array.from(new Map(teams.flatMap((t) => t.members).map((m) => [m.id, m.name])).entries());
  const filtered = !!(debouncedQ || status || priority || assignee);

  return (
    <>
      <div className="page-head">
        <h1>Items</h1>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>New item</button>
      </div>
      {creating && <NewItemForm onCancel={() => setCreating(false)} onDone={(id) => navigate(`/items/${id}`)} />}
      <div className="filters">
        <input type="search" placeholder="Search title or description…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
          <option value="">All priorities</option>{PRIORITIES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
          <option value="">Any assignee</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option>
          {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {!data && loading && <Loading />}
      {data && (
        <div className="card" aria-busy={loading}>
          <ItemRows items={data.data} empty={filtered ? 'No items match your filters.' : 'No items yet. Create the first one.'} />
          <div className="pager">
            <span className="muted">{data.total} item{data.total === 1 ? '' : 's'}</span>
            <button className="btn btn-small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {data.page} of {data.totalPages}</span>
            <button className="btn btn-small" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
      )}
    </>
  );
}
