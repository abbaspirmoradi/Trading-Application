import React, { useEffect, useState } from 'react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { X, Shield, Flame, Trash2, TriangleAlert, Plus } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext.jsx';

const PIE_COLORS = ['#38bdf8', '#10b981', '#a78bfa', '#fbbf24', '#f43f5e', '#22d3ee', '#f97316', '#84cc16'];
const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/**
 * Portfolio health, heat and stress testing. The correlation matrix is the
 * centrepiece: it is what reveals whether a book of eight names is really eight
 * independent bets or one bet held eight times.
 */
export default function PortfolioRiskView({ open, onClose, suggestion }) {
  const { portfolio, stress, refresh, refreshStress, removePosition, addPosition } = usePortfolio();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (open) { refresh(); refreshStress(); }
  }, [open, refresh, refreshStress]);

  if (!open) return null;

  const positions = portfolio?.positions || [];
  const heat = portfolio?.portfolioHeatPct ?? 0;
  const heatLimit = stress?.heatLimitPct ?? 6;
  const heatPct = Math.min((heat / heatLimit) * 100, 100);

  const allocation = positions.map((p) => ({
    name: p.ticker,
    value: Number(((p.currentPrice ?? p.entryPrice) * p.shares).toFixed(2)),
  }));
  const cashValue = Math.max(0, portfolio?.cash ?? 0);
  if (cashValue > 0) allocation.push({ name: 'Cash', value: Number(cashValue.toFixed(2)) });

  async function handleAddSuggestion() {
    if (!suggestion) return;
    setBusy(true);
    setErr(null);
    try {
      await addPosition(suggestion);
      await refreshStress();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 bg-black/70 backdrop-blur-sm overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-5xl panel bg-slate-900 my-4" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header sticky top-0 bg-slate-900 z-10 rounded-t-xl">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-rose-400" />
            <h2 className="text-sm font-semibold text-slate-200">Portfolio Health &amp; Stress Test</h2>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Headline stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Equity" value={usd(portfolio?.equity)} />
            <Stat label="Cash" value={usd(portfolio?.cash)} />
            <Stat label="Gross exposure" value={`${stress?.grossExposurePct ?? 0}%`} />
            <Stat
              label="Drawdown from peak"
              value={`${(portfolio?.drawdownPct ?? 0).toFixed(2)}%`}
              tone={(portfolio?.drawdownPct ?? 0) > 5 ? 'neg' : 'flat'}
            />
          </div>

          {/* Heat meter */}
          <div className="panel p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Flame className={`w-4 h-4 ${heat > heatLimit ? 'text-rose-400' : heat > heatLimit * 0.7 ? 'text-amber-400' : 'text-emerald-400'}`} />
                <span className="text-xs font-semibold text-slate-300">Portfolio Heat</span>
              </div>
              <span className="text-sm font-bold tabular-nums text-slate-100">
                {heat.toFixed(2)}% <span className="text-slate-500 font-normal">of {heatLimit}% limit</span>
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${heat > heatLimit ? 'bg-rose-500' : heat > heatLimit * 0.7 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${heatPct}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Total capital at risk across every open stop: {usd(stress?.portfolioHeatPct ? (stress.portfolioHeatPct / 100) * (portfolio?.equity ?? 0) : 0)}.
              {heat > heatLimit && <span className="text-rose-400"> Over the limit — new positions are blocked until stops tighten.</span>}
            </p>
          </div>

          {stress?.concentrationWarning && (
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-rose-950/40 border border-rose-800/60 text-xs text-rose-200">
              <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{stress.concentrationWarning}</span>
            </div>
          )}

          {/* Suggestion from the last analysis */}
          {suggestion && (
            <div className="panel p-4 border-emerald-800/50">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-300">
                  <span className="font-semibold text-emerald-400">Open the suggested position?</span>{' '}
                  {suggestion.shares} {suggestion.ticker} @ {suggestion.entryPrice} · stop {suggestion.stopPrice}
                </div>
                <button type="button" className="btn-primary flex items-center gap-1.5" onClick={handleAddSuggestion} disabled={busy}>
                  <Plus className="w-3.5 h-3.5" /> {busy ? 'Adding…' : 'Add to portfolio'}
                </button>
              </div>
              {err && <p className="mt-2 text-[11px] text-rose-400">{err}</p>}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Allocation */}
            <div className="panel p-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-3">Asset Allocation</h3>
              {allocation.length ? (
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={allocation} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={85} paddingAngle={2}>
                      {allocation.map((entry, i) => (
                        <Cell key={entry.name} fill={entry.name === 'Cash' ? '#475569' : PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                      formatter={(v, n) => [usd(v), n]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[220px] flex items-center justify-center text-slate-500 text-xs">No positions</div>
              )}
            </div>

            {/* Scenarios */}
            <div className="panel p-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-3">Scenario Stress Test</h3>
              {stress?.scenarios?.length ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={stress.scenarios} layout="vertical" margin={{ left: 10, right: 20 }}>
                    <CartesianGrid stroke="#1e293b" horizontal={false} />
                    <XAxis type="number" tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" width={130} tick={{ fill: '#94a3b8', fontSize: 9 }} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                      formatter={(v) => [usd(v), 'Estimated P&L']}
                    />
                    <Bar dataKey="estimatedPnl" fill="#f43f5e" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[220px] flex items-center justify-center text-slate-500 text-xs">Add positions to run a stress test</div>
              )}
            </div>
          </div>

          {/* Correlation matrix */}
          {stress?.matrix?.length > 1 && (
            <div className="panel p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Correlation Matrix (120-day returns)</h3>
                <span className="text-[11px] text-slate-500">
                  Average pairwise: <span className="text-slate-200 tabular-nums">{stress.avgCorrelation}</span>
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="text-[10.5px] tabular-nums">
                  <thead>
                    <tr>
                      <th className="p-1.5" />
                      {stress.matrix.map((row) => (
                        <th key={row.ticker} className="p-1.5 text-slate-400 font-medium">{row.ticker}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stress.matrix.map((row) => (
                      <tr key={row.ticker}>
                        <td className="p-1.5 text-slate-400 font-medium text-right pr-2">{row.ticker}</td>
                        {row.correlations.map((c, i) => (
                          <td key={i} className="p-1">
                            <div
                              className="w-11 h-7 rounded flex items-center justify-center text-[10px] font-medium"
                              style={{
                                backgroundColor: correlationColor(c.value),
                                color: Math.abs(c.value) > 0.55 ? '#fff' : '#cbd5e1',
                              }}
                            >
                              {c.value.toFixed(2)}
                            </div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[10.5px] text-slate-500">
                Red cells mark pairs above the 0.70 veto threshold — those positions will draw down together.
              </p>
            </div>
          )}

          {/* Positions */}
          <div className="panel">
            <div className="panel-header">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Open Positions ({positions.length})
              </h3>
            </div>
            {positions.length === 0 ? (
              <div className="p-6 text-center text-slate-500 text-xs">No open positions.</div>
            ) : (
              <div className="divide-y divide-slate-800">
                {positions.map((p) => {
                  const pnl = p.unrealizedPnl ?? 0;
                  return (
                    <div key={p._id} className="p-3 flex flex-wrap items-center gap-3 text-xs">
                      <span className="font-semibold text-slate-100 w-14">{p.ticker}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[9.5px] font-bold ${p.side === 'SHORT' ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                        {p.side}
                      </span>
                      <span className="text-slate-400 tabular-nums">{p.shares} sh @ {Number(p.entryPrice).toFixed(2)}</span>
                      <span className="text-slate-500 tabular-nums">stop {Number(p.stopPrice).toFixed(2)}</span>
                      <span className="text-slate-400 tabular-nums">mkt {Number(p.currentPrice ?? p.entryPrice).toFixed(2)}</span>
                      <span className={`tabular-nums font-semibold ${pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {pnl >= 0 ? '+' : ''}{usd(pnl)}
                      </span>
                      <span className="text-slate-500 tabular-nums">risk {usd(p.openRisk)}</span>
                      <button
                        type="button"
                        onClick={() => removePosition(p._id)}
                        className="ml-auto p-1.5 rounded hover:bg-rose-500/15 text-slate-500 hover:text-rose-400"
                        title="Close position"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function correlationColor(v) {
  const a = Math.abs(v);
  if (a >= 0.999) return '#334155';
  if (a > 0.70) return `rgba(244, 63, 94, ${0.35 + a * 0.5})`;
  if (a > 0.50) return `rgba(245, 158, 11, ${0.25 + a * 0.4})`;
  return `rgba(16, 185, 129, ${0.15 + a * 0.35})`;
}

function Stat({ label, value, tone = 'flat' }) {
  const color = tone === 'neg' ? 'text-rose-400' : tone === 'pos' ? 'text-emerald-400' : 'text-slate-100';
  return (
    <div className="panel p-3">
      <div className="stat-label">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
