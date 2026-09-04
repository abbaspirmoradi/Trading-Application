import React, { useState } from 'react';
import { Plus, Loader2, AlertTriangle } from 'lucide-react';
import api from '../services/api.js';

/**
 * Entry form for existing holdings. A stop is mandatory: the entire risk engine
 * — heat, position sizing, R-multiples, the advisor's exit logic — is defined
 * relative to where you get out. A position without one cannot be measured.
 */
export default function PositionForm({ onAdded }) {
  const [form, setForm] = useState({ ticker: '', shares: '', entryPrice: '', stopPrice: '', profitTarget: '', side: 'LONG', thesis: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [lookup, setLookup] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Pre-fill the entry price with the live quote — most people are entering a
  // position they already hold and know the ticker better than the price.
  async function fetchQuote() {
    const t = form.ticker.trim().toUpperCase();
    if (!t) return;
    try {
      const { quotes } = await api.marketOverview([t]);
      const q = quotes[0];
      if (q) {
        setLookup(q);
        setForm((f) => ({
          ...f,
          entryPrice: f.entryPrice || String(q.price),
          stopPrice: f.stopPrice || (q.price * 0.92).toFixed(2),
        }));
      }
    } catch { setLookup(null); }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addPosition({
        ticker: form.ticker.trim().toUpperCase(),
        side: form.side,
        shares: Number(form.shares),
        entryPrice: Number(form.entryPrice),
        stopPrice: Number(form.stopPrice),
        profitTarget: form.profitTarget ? Number(form.profitTarget) : undefined,
        thesis: form.thesis,
      });
      setForm({ ticker: '', shares: '', entryPrice: '', stopPrice: '', profitTarget: '', side: 'LONG', thesis: '' });
      setLookup(null);
      onAdded?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const risk = Number(form.shares) && Number(form.entryPrice) && Number(form.stopPrice)
    ? Math.abs(Number(form.entryPrice) - Number(form.stopPrice)) * Number(form.shares)
    : null;

  return (
    <form onSubmit={submit} className="panel p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-3">Add a holding</h3>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <label className="block">
          <span className="stat-label block mb-1">Ticker</span>
          <input
            required value={form.ticker} onChange={set('ticker')} onBlur={fetchQuote}
            className={inputCls} placeholder="NVDA"
            style={{ textTransform: 'uppercase' }}
          />
        </label>

        <label className="block">
          <span className="stat-label block mb-1">Side</span>
          <select value={form.side} onChange={set('side')} className={inputCls}>
            <option value="LONG">Long</option>
            <option value="SHORT">Short</option>
          </select>
        </label>

        <label className="block">
          <span className="stat-label block mb-1">Shares</span>
          <input required type="number" min="0" step="any" value={form.shares} onChange={set('shares')} className={inputCls} placeholder="100" />
        </label>

        <label className="block">
          <span className="stat-label block mb-1">Entry price</span>
          <input required type="number" min="0" step="any" value={form.entryPrice} onChange={set('entryPrice')} className={inputCls} placeholder="185.00" />
        </label>

        <label className="block">
          <span className="stat-label block mb-1">Stop price</span>
          <input required type="number" min="0" step="any" value={form.stopPrice} onChange={set('stopPrice')} className={inputCls} placeholder="172.00" />
        </label>

        <label className="block">
          <span className="stat-label block mb-1">Target (optional)</span>
          <input type="number" min="0" step="any" value={form.profitTarget} onChange={set('profitTarget')} className={inputCls} placeholder="240.00" />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input value={form.thesis} onChange={set('thesis')} className={`${inputCls} flex-1 min-w-[200px]`} placeholder="Why you own it (optional)" />
        <button type="submit" disabled={busy} className="btn-primary flex items-center gap-1.5 px-4 py-2">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          {busy ? 'Adding…' : 'Add holding'}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[10.5px] text-slate-500">
        {lookup && <span>Live quote for {lookup.ticker}: <span className="text-slate-300 tabular-nums">{lookup.price?.toFixed(2)}</span> ({lookup.date})</span>}
        {risk != null && (
          <span>
            Risk between entry and stop:{' '}
            <span className="text-amber-400 tabular-nums">${risk.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
          </span>
        )}
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 p-2.5 rounded-lg bg-rose-950/40 border border-rose-800/60 text-xs text-rose-200">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </form>
  );
}

const inputCls = 'w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-700 focus:ring-1 focus:ring-sky-800';
