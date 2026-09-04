import React, { useCallback, useEffect, useState } from 'react';
import {
  ShieldAlert, AlertTriangle, TrendingUp, Info, Loader2, RefreshCw, ArrowUpCircle,
  Trash2, Activity, CheckCircle2, Layers,
} from 'lucide-react';
import api from '../services/api.js';
import PositionForm from './PositionForm.jsx';
import { useAgents } from '../context/AgentContext.jsx';

const SEVERITY_STYLE = {
  CRITICAL: { bg: 'bg-rose-950/40 border-rose-800/60', text: 'text-rose-300', Icon: ShieldAlert, label: 'Act now' },
  WARNING: { bg: 'bg-amber-950/30 border-amber-800/50', text: 'text-amber-300', Icon: AlertTriangle, label: 'Attention' },
  OPPORTUNITY: { bg: 'bg-emerald-950/30 border-emerald-800/50', text: 'text-emerald-300', Icon: TrendingUp, label: 'Opportunity' },
  INFO: { bg: 'bg-slate-800/40 border-slate-700/60', text: 'text-slate-300', Icon: Info, label: 'Note' },
};

const VERDICT_STYLE = {
  EXIT: 'bg-rose-500/15 text-rose-300',
  TRIM: 'bg-amber-500/15 text-amber-300',
  ADD: 'bg-emerald-500/15 text-emerald-300',
  HOLD: 'bg-slate-600/20 text-slate-300',
};

const usd = (n) => `${n < 0 ? '-' : ''}$${Math.abs(Number(n || 0)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/**
 * The portfolio review. Alerts are ordered by severity, not by ticker, because
 * the question a holder actually has is "what needs doing?" — not "how is each
 * position, alphabetically".
 */
export default function PortfolioAdvisor() {
  const { activeIds } = useAgents();
  const [review, setReview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [acting, setActing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { review: r } = await api.reviewPortfolio(activeIds);
      setReview(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeIds]);

  useEffect(() => { load(); }, [load]);

  async function raiseStop(holding) {
    if (!holding.suggestedStop) return;
    setActing(holding.positionId);
    try {
      await api.patchPosition(holding.positionId, { stopPrice: holding.suggestedStop });
      await load();
    } catch (err) { setError(err.message); } finally { setActing(null); }
  }

  async function closePosition(holding) {
    setActing(holding.positionId);
    try {
      await api.removePosition(holding.positionId);
      await load();
    } catch (err) { setError(err.message); } finally { setActing(null); }
  }

  const s = review?.summary;

  return (
    <div className="space-y-4">
      <PositionForm onAdded={load} />

      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-slate-200">Portfolio Review</h2>
            {review && <span className="text-[10.5px] text-slate-500">{new Date(review.generatedAt).toLocaleString()}</span>}
          </div>
          <button type="button" onClick={load} disabled={loading} className="btn-ghost flex items-center gap-1.5">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {loading ? 'Reviewing…' : 'Re-run review'}
          </button>
        </div>

        {error && <div className="p-4 text-xs text-rose-400">{error}</div>}

        {loading && !review && (
          <div className="p-12 flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
            <p className="text-sm text-slate-400">Running every agent across your holdings…</p>
          </div>
        )}

        {review && (
          <div className="p-4 space-y-4">
            <p className={`text-sm font-medium ${s.alertCounts.critical ? 'text-rose-300' : s.alertCounts.warning ? 'text-amber-300' : 'text-emerald-300'}`}>
              {review.headline}
            </p>

            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2.5">
              <Stat label="Equity" value={usd(s.equity)} />
              <Stat label="Cash" value={usd(s.cash)} />
              <Stat label="Open P&L" value={usd(s.totalUnrealizedPnl)} tone={s.totalUnrealizedPnl >= 0 ? 'pos' : 'neg'} />
              <Stat label="Deployed" value={`${s.grossExposurePct}%`} />
              <Stat
                label="Heat"
                value={`${s.portfolioHeatPct}%`}
                tone={s.portfolioHeatPct >= s.heatLimitPct ? 'neg' : s.portfolioHeatPct > s.heatLimitPct * 0.75 ? 'warn' : 'pos'}
                hint={`limit ${s.heatLimitPct}%`}
              />
              <Stat label="Drawdown" value={`${s.drawdownPct}%`} tone={s.drawdownPct > 5 ? 'neg' : 'flat'} />
              <Stat label="At risk" value={usd(s.totalOpenRisk)} hint="if every stop hit" />
            </div>

            {/* Diversification reality check */}
            {review.correlations && s.positions > 1 && (
              <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[11px]">
                <span className="flex items-center gap-1.5 text-slate-400">
                  <Layers className="w-3.5 h-3.5 text-violet-400" /> Diversification
                </span>
                <span className="text-slate-400">
                  Average correlation <span className="text-slate-100 tabular-nums font-semibold">{review.correlations.averageCorrelation}</span>
                </span>
                <span className="text-slate-400">
                  {s.positions} holdings behave like{' '}
                  <span className={`tabular-nums font-semibold ${review.correlations.effectiveBets < s.positions * 0.6 ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {review.correlations.effectiveBets}
                  </span>{' '}
                  independent bet{review.correlations.effectiveBets < 1.5 ? '' : 's'}
                </span>
              </div>
            )}

            {/* Action list */}
            {review.alerts.length > 0 && (
              <div className="space-y-2">
                {review.alerts.map((a, i) => {
                  const style = SEVERITY_STYLE[a.severity];
                  const { Icon } = style;
                  return (
                    <div key={`${a.code}-${a.ticker}-${i}`} className={`p-3 rounded-lg border ${style.bg}`}>
                      <div className="flex items-start gap-2.5">
                        <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${style.text}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-xs font-semibold ${style.text}`}>{a.title}</span>
                            {a.ticker && <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[9.5px] font-bold">{a.ticker}</span>}
                            <span className="text-[9px] uppercase tracking-wider text-slate-500">{style.label}</span>
                          </div>
                          <p className="mt-1 text-[11px] text-slate-300 leading-relaxed">{a.detail}</p>
                          <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">
                            <span className="text-slate-500">What to do: </span>{a.action}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Holdings table */}
            {review.holdings.length > 0 && (
              <div className="panel overflow-hidden">
                <div className="panel-header">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Holdings ({review.holdings.length})
                  </h3>
                  <div className="flex gap-2 text-[10px]">
                    {Object.entries(s.verdicts).filter(([, v]) => v > 0).map(([k, v]) => (
                      <span key={k} className={`px-1.5 py-0.5 rounded font-bold ${VERDICT_STYLE[k]}`}>{v} {k}</span>
                    ))}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-slate-500 border-b border-slate-800">
                        {['Ticker', 'Verdict', 'Shares', 'Entry', 'Now', 'P&L', 'R', 'Stage', 'RS', 'Weight', 'Stop', 'Actions'].map((h) => (
                          <th key={h} className="px-2.5 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {review.holdings.map((h) => (
                        <tr key={h.positionId} className="hover:bg-slate-800/30">
                          <td className="px-2.5 py-2 font-semibold text-slate-100">{h.ticker}</td>
                          <td className="px-2.5 py-2">
                            <span className={`px-1.5 py-0.5 rounded text-[9.5px] font-bold ${VERDICT_STYLE[h.verdict]}`}>{h.verdict}</span>
                          </td>
                          <td className="px-2.5 py-2 tabular-nums text-slate-300">{h.shares}</td>
                          <td className="px-2.5 py-2 tabular-nums text-slate-400">{h.entryPrice?.toFixed(2)}</td>
                          <td className="px-2.5 py-2 tabular-nums text-slate-100">{h.currentPrice?.toFixed(2)}</td>
                          <td className={`px-2.5 py-2 tabular-nums font-semibold ${h.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {usd(h.unrealizedPnl)}
                            <span className="text-slate-500 font-normal"> ({h.unrealizedPnlPct}%)</span>
                          </td>
                          <td className={`px-2.5 py-2 tabular-nums ${h.rMultiple >= 0 ? 'text-slate-300' : 'text-rose-400'}`}>{h.rMultiple}R</td>
                          <td className="px-2.5 py-2 tabular-nums">
                            <span className={h.stage === 2 ? 'text-emerald-400' : h.stage === 4 ? 'text-rose-400' : 'text-slate-400'}>
                              {h.stage ?? '—'}
                            </span>
                          </td>
                          <td className="px-2.5 py-2 tabular-nums text-slate-400">{h.rsRating ?? '—'}</td>
                          <td className="px-2.5 py-2 tabular-nums text-slate-400">{h.weightPct}%</td>
                          <td className="px-2.5 py-2 tabular-nums text-slate-400">
                            {h.stopPrice?.toFixed(2)}
                            {h.suggestedStop && <span className="text-emerald-400"> → {h.suggestedStop}</span>}
                          </td>
                          <td className="px-2.5 py-2">
                            <div className="flex gap-1.5">
                              {h.suggestedStop && (
                                <button
                                  type="button" onClick={() => raiseStop(h)} disabled={acting === h.positionId}
                                  className="p-1 rounded hover:bg-emerald-500/15 text-slate-500 hover:text-emerald-400"
                                  title={`Move stop to ${h.suggestedStop}`}
                                >
                                  {acting === h.positionId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpCircle className="w-3.5 h-3.5" />}
                                </button>
                              )}
                              <button
                                type="button" onClick={() => closePosition(h)} disabled={acting === h.positionId}
                                className="p-1 rounded hover:bg-rose-500/15 text-slate-500 hover:text-rose-400"
                                title="Close position"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {review.holdings.length === 0 && !loading && (
              <div className="py-10 text-center">
                <CheckCircle2 className="w-7 h-7 text-slate-700 mx-auto mb-2" />
                <p className="text-sm text-slate-300">No holdings yet</p>
                <p className="text-xs text-slate-500 mt-1">Add your positions above and the advisor will review them on every run.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'flat', hint }) {
  const color = { pos: 'text-emerald-400', neg: 'text-rose-400', warn: 'text-amber-400', flat: 'text-slate-100' }[tone];
  return (
    <div className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800">
      <div className="stat-label">{label}</div>
      <div className={`text-sm font-bold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="text-[9px] text-slate-600 mt-0.5">{hint}</div>}
    </div>
  );
}
