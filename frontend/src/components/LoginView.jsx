import React, { useState } from 'react';
import { LayoutGrid, Loader2, AlertTriangle, LogIn, UserPlus } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Sign-in / registration gate. Registration also captures opening equity,
 * because every sizing and risk calculation in the system is a percentage of
 * account equity — without it the advisor has no denominator.
 */
export default function LoginView() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', startingEquity: 100000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') {
        await signIn(form.email.trim(), form.password);
      } else {
        await signUp({
          email: form.email.trim(),
          password: form.password,
          name: form.name.trim(),
          startingEquity: Number(form.startingEquity) || 100000,
        });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-6 justify-center">
          <div className="p-2 rounded-lg bg-emerald-500/15">
            <LayoutGrid className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-100 leading-tight">Multi-Agent Trading Terminal</h1>
            <p className="text-[11px] text-slate-500 leading-tight">Sign in to track and analyse your holdings</p>
          </div>
        </div>

        <div className="panel p-6">
          <div className="flex gap-1 mb-5 p-1 bg-slate-950/60 rounded-lg">
            {['login', 'register'].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setError(null); }}
                className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  mode === m ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {m === 'login' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-3.5">
            {mode === 'register' && (
              <Field label="Name (optional)">
                <input value={form.name} onChange={set('name')} className={inputCls} placeholder="Your name" autoComplete="name" />
              </Field>
            )}

            <Field label="Email">
              <input type="email" required value={form.email} onChange={set('email')} className={inputCls} placeholder="you@example.com" autoComplete="email" />
            </Field>

            <Field label="Password">
              <input
                type="password" required minLength={8} value={form.password} onChange={set('password')}
                className={inputCls} placeholder="At least 8 characters"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </Field>

            {mode === 'register' && (
              <Field label="Account equity" hint="Every risk limit and position size is a percentage of this figure.">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                  <input
                    type="number" min="1000" step="1000" required value={form.startingEquity}
                    onChange={set('startingEquity')} className={`${inputCls} pl-7`}
                  />
                </div>
              </Field>
            )}

            {error && (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-rose-950/40 border border-rose-800/60 text-xs text-rose-200">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button type="submit" disabled={busy} className="btn-primary w-full flex items-center justify-center gap-2 py-2.5">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" />
                : mode === 'login' ? <LogIn className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="mt-4 text-[10.5px] text-slate-600 text-center leading-relaxed">
          Analytical software, not investment advice. It places no orders and connects to no broker.
          Price data is real; fundamentals, options, news and macro inputs are modelled.
        </p>
      </div>
    </div>
  );
}

const inputCls = 'w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-700 focus:ring-1 focus:ring-sky-800';

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="stat-label block mb-1">{label}</span>
      {children}
      {hint && <span className="block mt-1 text-[10px] text-slate-600 leading-snug">{hint}</span>}
    </label>
  );
}
