import { FormEvent, useState } from 'react';
import { api, ApiError } from './api';
import { useApp } from './ctx';
import type { ActivityEvent, Item, Priority, Status } from './types';
import { PRIORITIES } from './types';
import { ErrorBanner, fmtDate, fmtDateTime, label, Loading, PriorityBadge, StatusBadge, useFetch } from './ui';

function describe(e: ActivityEvent): string {
  switch (e.type) {
    case 'CREATED': return 'created this item';
    case 'STATUS_CHANGED': return `moved status ${label(e.fromValue ?? '')} → ${label(e.toValue ?? '')}`;
    case 'PRIORITY_CHANGED': return `changed priority ${label(e.fromValue ?? '')} → ${label(e.toValue ?? '')}`;
    case 'ASSIGNEE_CHANGED': return e.toLabel ? (e.fromLabel ? `reassigned ${e.fromLabel} → ${e.toLabel}` : `assigned to ${e.toLabel}`) : `unassigned ${e.fromLabel ?? ''}`;
    case 'FIELDS_UPDATED': return `updated ${e.field}`;
    case 'COMMENT_ADDED': return 'commented';
  }
}

export default function ItemDetail({ id }: { id: string }) {
  const { teams } = useApp();
  const item = useFetch(() => api<Item>('GET', `/api/items/${id}`), [id]);
  const activity = useFetch(() => api<{ data: ActivityEvent[] }>('GET', `/api/items/${id}/activity`), [id]);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', description: '', priority: 'MEDIUM' as Priority });

  const it = item.data;
  async function act(fn: () => Promise<Item | void>) {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fn();
      if (res) item.setData(res);
      activity.reload();
    } catch (e) {
      setActionError(e as ApiError);
      if ((e as ApiError).status === 409) item.reload(); // show the fresh state after a conflict
    } finally {
      setBusy(false);
    }
  }

  if (item.error) return <ErrorBanner error={item.error} onRetry={item.reload} />;
  if (!it) return <Loading />;
  const a = it.access!;
  const teamMembers = teams.find((t) => t.id === it.teamId)?.members.filter((m) => m.role !== 'VIEWER') ?? [];

  const submitEdit = (e: FormEvent) => {
    e.preventDefault();
    act(async () => { const r = await api<Item>('PATCH', `/api/items/${id}`, { version: it.version, ...draft }); setEditing(false); return r; });
  };
  const submitComment = (e: FormEvent) => {
    e.preventDefault();
    act(async () => { await api('POST', `/api/items/${id}/comments`, { body: comment }); setComment(''); });
  };

  return (
    <>
      <a href="#/items" className="back">← All items</a>
      <ErrorBanner error={actionError} />
      <div className="detail">
        <section className="card">
          {editing ? (
            <form className="form" onSubmit={submitEdit}>
              <label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
              <label>Description<textarea rows={5} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
              <label>Priority<select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{label(p)}</option>)}</select></label>
              <div className="actions"><button className="btn btn-primary" disabled={busy || !draft.title.trim()}>Save</button>
                <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button></div>
            </form>
          ) : (
            <>
              <h1>{it.title}</h1>
              <div className="row-meta"><PriorityBadge priority={it.priority} /><StatusBadge status={it.status} /><span className="muted">{label(it.type)}</span></div>
              <p className="desc">{it.description || <span className="muted">No description.</span>}</p>
              <dl className="facts">
                <dt>Team</dt><dd>{it.team.name}</dd>
                <dt>Assignee</dt><dd>{it.assignee?.name ?? 'Unassigned'}</dd>
                <dt>Created by</dt><dd>{it.createdBy.name}</dd>
                <dt>Due</dt><dd>{fmtDate(it.dueDate)}</dd>
                <dt>Updated</dt><dd>{fmtDateTime(it.updatedAt)} (v{it.version})</dd>
              </dl>
              <div className="actions">
                {a.canClaim && <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api<Item>('POST', `/api/items/${id}/claim`))}>Claim</button>}
                {a.transitions.map((to: Status) => (
                  <button key={to} className="btn" disabled={busy}
                    onClick={() => act(() => api<Item>('POST', `/api/items/${id}/transition`, { to, version: it.version }))}>
                    {it.status === 'AWAITING_APPROVAL' && to === 'RESOLVED' ? 'Approve' : it.status === 'AWAITING_APPROVAL' && to === 'IN_PROGRESS' ? 'Send back' : `Move to ${label(to)}`}
                  </button>
                ))}
                {a.canEdit && <button className="btn" onClick={() => { setDraft({ title: it.title, description: it.description, priority: it.priority }); setEditing(true); }}>Edit</button>}
              </div>
              {a.canAssign && (
                <label className="assign">Assign to
                  <select value={it.assigneeId ?? ''} disabled={busy}
                    onChange={(e) => act(() => api<Item>('PATCH', `/api/items/${id}`, { version: it.version, assigneeId: e.target.value || null }))}>
                    <option value="">Unassigned</option>
                    {teamMembers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select></label>
              )}
              {!a.canEdit && !a.canClaim && a.transitions.length === 0 && <p className="muted">You have read-only access ({label(a.role)}).</p>}
            </>
          )}
        </section>
        <section className="card">
          <h2>Activity</h2>
          {a.canComment && (
            <form className="comment-form" onSubmit={submitComment}>
              <textarea rows={2} placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} />
              <button className="btn btn-primary" disabled={busy || !comment.trim()}>Comment</button>
            </form>
          )}
          {activity.error && <ErrorBanner error={activity.error} onRetry={activity.reload} />}
          {!activity.data && activity.loading && <Loading />}
          <ul className="timeline">
            {activity.data?.data.map((e) => (
              <li key={e.id}>
                <div><strong>{e.actorName}</strong> {describe(e)} <span className="muted">· {fmtDateTime(e.createdAt)}</span></div>
                {e.commentBody && <blockquote>{e.commentBody}</blockquote>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
