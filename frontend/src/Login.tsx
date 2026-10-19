import { FormEvent, useState } from 'react';
import { api, ApiError, setToken } from './api';

// Shown only by the Vite dev server so reviewers can switch roles quickly. Not in production builds.
const DEMO = import.meta.env.DEV
  ? [
      ['Admin (Payments Ops)', 'alice.admin@demo.test'],
      ['Lead (Payments Ops)', 'lena.lead@demo.test'],
      ['Member (Payments Ops)', 'mark.member@demo.test'],
      ['Viewer (Payments Ops)', 'victor.viewer@demo.test'],
      ['Lead (Customer Support)', 'sara.support@demo.test'],
    ]
  : [];

export default function Login({ notice, onLoggedIn }: { notice?: string; onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string }>('POST', '/api/auth/login', { email, password });
      setToken(res.token);
      onLoggedIn();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const fieldErrors = error?.fieldErrors ?? {};
  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit} noValidate>
        <h1>Ops Desk</h1>
        <p className="muted">Sign in to manage operational work.</p>
        {notice && <div className="banner banner-warn">{notice}</div>}
        {error && !Object.keys(fieldErrors).length && (
          <div className="banner banner-error" role="alert">{error.message}</div>
        )}
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          {fieldErrors.email && <span className="field-error">{fieldErrors.email}</span>}
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}
        </label>
        <button className="btn btn-primary" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {DEMO.length > 0 && (
          <div className="demo">
            <span className="muted">Dev only — fill demo account (password in README):</span>
            {DEMO.map(([name, mail]) => (
              <button type="button" key={mail} className="btn btn-small" onClick={() => { setEmail(mail); setPassword('Demo#Pass123'); }}>
                {name}
              </button>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}
