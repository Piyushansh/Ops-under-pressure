import { api } from './api';
import { useApp } from './ctx';
import type { DashboardSummary, Section } from './types';
import { ErrorBanner, ItemRows, Loading, useFetch } from './ui';

function Card({ title, hint, section, empty }: { title: string; hint: string; section: Section; empty: string }) {
  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>{title}</h2>
          <p className="muted">{hint}</p>
        </div>
        <span className="count">{section.count}</span>
      </header>
      <ItemRows items={section.items} empty={empty} />
      {section.count > section.items.length && (
        <p className="muted more">Showing the newest {section.items.length} of {section.count}. Use Items to see all.</p>
      )}
    </section>
  );
}

export default function Dashboard() {
  const { user, memberships } = useApp();
  const { data, error, loading, reload } = useFetch(() => api<DashboardSummary>('GET', '/api/dashboard/summary'), []);
  const leads = memberships.some((m) => m.role === 'LEAD' || m.role === 'ADMIN');
  return (
    <>
      <div className="page-head">
        <h1>Hello, {user.name.split(' ')[0]}</h1>
        <button className="btn" onClick={reload} disabled={loading}>Refresh</button>
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {!data && loading && <Loading text="Loading your dashboard…" />}
      {data && (
        <div className="grid3">
          <Card title="Assigned to me" hint="Open work you own" section={data.assignedToMe} empty="Nothing assigned to you. Claim an item from the list." />
          <Card title="Unassigned urgent" hint="Urgent items nobody owns yet" section={data.unassignedUrgent} empty="No unassigned urgent items. Nice." />
          <Card
            title="Awaiting my approval"
            hint={leads ? 'Waiting for a lead of the team' : 'Only leads and admins approve'}
            section={data.awaitingMyApproval}
            empty={leads ? 'Nothing waiting for your approval.' : 'You are not a lead of any team.'}
          />
        </div>
      )}
    </>
  );
}
