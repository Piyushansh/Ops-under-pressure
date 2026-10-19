import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken, setToken, setUnauthorizedHandler } from './api';
import { AppCtx } from './ctx';
import Dashboard from './Dashboard';
import ItemDetail from './ItemDetail';
import Items from './Items';
import Login from './Login';
import type { Membership, Team, User } from './types';
import { ErrorBanner, label, Loading } from './ui';

const useHash = () => {
  const [h, setH] = useState(window.location.hash.slice(1) || '/');
  useEffect(() => {
    const f = () => setH(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h;
};

export default function App() {
  const route = useHash();
  const [session, setSession] = useState<{ user: User; memberships: Membership[]; teams: Team[] } | null>(null);
  const [booting, setBooting] = useState(!!getToken());
  const [bootError, setBootError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string>();

  const logout = useCallback((msg?: string) => {
    setToken(null);
    setSession(null);
    setNotice(msg);
    window.location.hash = '/';
  }, []);
  useEffect(() => setUnauthorizedHandler(() => logout('Your session expired. Please sign in again.')), [logout]);

  const load = useCallback(async () => {
    if (!getToken()) { setBooting(false); return; }
    setBooting(true);
    setBootError(null);
    try {
      const [me, teams] = await Promise.all([
        api<{ user: User; memberships: Membership[] }>('GET', '/api/auth/me'),
        api<{ data: Team[] }>('GET', '/api/teams'),
      ]);
      setSession({ ...me, teams: teams.data });
    } catch (e) {
      if ((e as ApiError).status !== 401) setBootError(e as ApiError);
    } finally {
      setBooting(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (booting) return <Loading text="Starting…" />;
  if (bootError) return <div className="page"><ErrorBanner error={bootError} onRetry={load} /></div>;
  if (!session) return <Login notice={notice} onLoggedIn={() => { setNotice(undefined); load(); }} />;

  const detail = route.match(/^\/items\/([0-9a-f-]{36})$/);
  const nav = (p: string, text: string) => <a href={`#${p}`} className={route === p ? 'active' : ''}>{text}</a>;
  return (
    <AppCtx.Provider value={{ ...session, logout: () => logout() }}>
      <header className="topbar">
        <strong>Ops Desk</strong>
        <nav>{nav('/', 'Dashboard')}{nav('/items', 'Items')}</nav>
        <span className="spacer" />
        <span className="who" title={session.memberships.map((m) => `${m.teamName}: ${label(m.role)}`).join('\n')}>{session.user.name}</span>
        <button className="btn btn-small" onClick={() => logout()}>Log out</button>
      </header>
      <main className="page">
        {detail ? <ItemDetail key={detail[1]} id={detail[1]} /> : route === '/items' ? <Items /> : <Dashboard />}
      </main>
    </AppCtx.Provider>
  );
}
