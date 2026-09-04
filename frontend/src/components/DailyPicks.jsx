import React, { useCallback, useEffect, useState } from 'react';
import {
  Sparkles, Loader2, RefreshCw, Eye, Ban, ChevronDown, ChevronRight, Gauge, Plus, Check,
} from 'lucide-react';
import api from '../services/api.js';
import { useAgents } from '../context/AgentContext.jsx';

const TONE_STYLE = {
  BROAD_ADVANCE: { text: 'text-emerald-300', bg: 'bg-emerald-950/30 border-emerald-800/50', label: 'Broad advance' },
  MIXED: { text: 'text-sky-300', bg: 'bg-sky-950/30 border-sky-800/50', label: 'Mixed' },
  NARROW: { text: 'text-amber-300', bg: 'bg-amber-950/30 border-amber-800/50', label: 'Narrow' },
  DEFENSIVE: { text: 'text-rose-300', bg: 'bg-rose-950/30 border-rose-800/50', label: 'Defensive' },
};

const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/**
 * Daily screen. A name only reaches the picks list if it clears every hard veto
 * — the watchlist below exists precisely so that "good, but blocked" is visible
 * as its own category rather than being quietly promoted or silently dropped.
 */
export default function DailyPicks({ onAnalyse }) {
  const { activeIds } = useAgents();
  const [screen, setScreen] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [added, setAdded] = useState({});

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const { screen: s } = await api.dailyPicks({ limit: 10, refresh, activeAgents: activeIds });
      setScreen(s);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeIds]);

  useEffect(() => { load(false); }, [load]);

  async function addPick(p) {
    try {
      await api.addPosition({
        ticker: p.ticker,
        side: 'LONG',
        shares: p.suggestedShares,
        entryPrice: p.entryTrigger,
        stopPrice: p.stopLoss,
        profitTarget: p.profitTarget,
        thesis: p.rationale?.[0] ?? '',
      });
      setAdded((a) => ({ ...a, [p.ticker]: true }));
    } catch (err) {
      setError(err.message);
    }
  }

  const tone = screen ? TONE_STYLE[screen.marketBreadth.tone] : null;

  return (
    <div className="space-y-4">
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-slate-200">Daily Picks</h2>
            {screen && (
              <span className="text-[10.5px] text-slate-500">
                {screen.analysed}/{screen.universeSize} screened · {(screen.elapsedMs / 1000).toFixed(1)}s
                {screen.cached && <span className="text-slate-600"> · cached {screen.cacheAgeSeconds}s ago</span>}
              </span>
            )}
          </div>
          <button type="button" onClick={() => load(true)} disabled={loading} className="btn-ghost flex items-center gap-1.5">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {loading ? 'Screening…' : 'Re-screen'}
          </button>
        </div>

        {error && <div className="p-4 text-xs text-rose-400">{error}</div>}

        {loading && !screen && (
          <div className="p-12 flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-amber-400" />
            <p className="text-sm text-slate-400">Running every active agent across the universe…</p>
            <p className="text-xs text-slate-600">This takes a few seconds — each name gets a full pipeline run.</p>
          </div>
        )}

        {screen && (
          <div className="p-4 space-y-4">
            {/* Market breadth — the context every pick sits inside */}
            <div className={`p-3 rounded-lg border ${tone.bg}`}>
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <Gauge className={`w-3.5 h-3.5 ${tone.text}`} />
                <span className={`text-xs font-semibold ${tone.text}`}>Market breadth: {tone.label}</span>
                <span className="text-[10.5px] text-slate-400 tabular-nums">
                  Stage 2: {screen.marketBreadth.stage2} · Stage 1: {screen.marketBreadth.stage1} ·
                  Stage 3: {screen.marketBreadth.stage3} · Stage 4: {screen.marketBreadth.stage4}
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">{screen.marketBreadth.interpretation}</p>
            </div>

            {/* Picks */}
            {screen.picks.length === 0 ? (
              <div className="py-8 text-center">
                <Ban className="w-7 h-7 text-slate-700 mx-auto mb-2" />
                <p className="text-sm text-slate-300">Nothing qualifies today</p>
                <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                  No name cleared every hard veto. An empty list is a real answer — forcing a trade
                  when nothing sets up is how good systems get overridden.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {screen.picks.map((p, i) => {
                  const open = expanded === p.ticker;
                  return (
                    <div key={p.ticker} className="rounded-lg border border-slate-800 bg-slate-900/50 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : p.ticker)}
                        className="w-full p-3 text-left hover:bg-slate-800/40 transition-colors"
                      >
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="text-[10px] text-slate-600 tabular-nums w-4">#{i + 1}</span>
                          {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
                          <span className="text-sm font-bold text-slate-100 w-16">{p.ticker}</span>
                          <span className="text-xs tabular-nums text-slate-300 w-20">{p.price?.toFixed(2)}</span>

                          <span className={`px-1.5 py-0.5 rounded text-[9.5px] font-bold ${
                            p.finalAction === 'STRONG_BUY' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-500/10 text-emerald-400'
                          }`}>
                            {p.finalAction.replace('_', ' ')}
                          </span>

                          <div className="flex items-center gap-1.5 flex-1 min-w-[120px]">
                            <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden max-w-[140px]">
                              <div className="h-full bg-amber-500" style={{ width: `${Math.min(p.rankScore, 100)}%` }} />
                            </div>
                            <span className="text-[10.5px] tabular-nums text-amber-400 font-semibold">{p.rankScore}</span>
                          </div>

                          <span className="text-[10.5px] text-slate-500">RS <span className="text-slate-300 tabular-nums">{p.rsRating}</span></span>
                          <span className="text-[10.5px] text-slate-500">Stage <span className="text-emerald-400">{p.stage}</span></span>
                          <span className="text-[10.5px] text-slate-500">R:R <span className="text-slate-300 tabular-nums">{p.riskRewardRatio}</span></span>
                          {p.pattern && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{p.pattern}</span>}
                          {p.freshBreakout && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">fresh breakout</span>}
                        </div>
                      </button>

                      {open && (
                        <div className="px-3 pb-3 pt-1 border-t border-slate-800/70 space-y-3">
                          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                            <Field label="Entry trigger" value={p.entryTrigger?.toFixed(2)} />
                            <Field label="Stop loss" value={p.stopLoss?.toFixed(2)} tone="neg" />
                            <Field label="Profit target" value={p.profitTarget?.toFixed(2)} tone="pos" />
                            <Field label="Suggested size" value={`${p.suggestedShares} sh`} />
                            <Field label="Allocation" value={usd(p.allocationDollar)} />
                            <Field label="P(profit)" value={`${(p.probabilityOfProfit * 100).toFixed(0)}%`} />
                          </div>

                          {p.rationale?.length > 0 && (
                            <ul className="space-y-1">
                              {p.rationale.map((r, k) => (
                                <li key={k} className="text-[11px] text-slate-400 flex gap-1.5 leading-relaxed">
                                  <span className="text-slate-600 shrink-0">•</span><span>{r}</span>
                                </li>
                              ))}
                            </ul>
                          )}

                          {/* Why it ranked where it did */}
                          <div className="flex flex-wrap gap-1.5">
                            {Object.entries(p.rankComponents).map(([k, v]) => (
                              <span key={k} className="px-1.5 py-0.5 rounded bg-slate-800/70 text-[10px] text-slate-400 tabular-nums">
                                {k} {v}
                              </span>
                            ))}
                          </div>

                          <div className="flex gap-2">
                            <button type="button" onClick={() => onAnalyse?.(p.ticker)} className="btn-ghost flex items-center gap-1.5">
                              <Eye className="w-3.5 h-3.5" /> Full analysis
                            </button>
                            <button
                              type="button" onClick={() => addPick(p)} disabled={added[p.ticker]}
                              className="btn-primary flex items-center gap-1.5"
                            >
                              {added[p.ticker] ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                              {added[p.ticker] ? 'Added' : `Add ${p.suggestedShares} shares`}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Held back */}
            {screen.watchlist.length > 0 && (
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Strong, but held back
                </h3>
                <div className="space-y-1">
                  {screen.watchlist.map((w) => (
                    <div key={w.ticker} className="flex items-center gap-3 p-2 rounded-lg bg-slate-900/40 border border-slate-800/70 text-[11px] flex-wrap">
                      <span className="font-semibold text-slate-200 w-14">{w.ticker}</span>
                      <span className="tabular-nums text-slate-400 w-20">{w.price?.toFixed(2)}</span>
                      <span className="tabular-nums text-amber-400/80 w-12">{w.rankScore}</span>
                      <span className="text-slate-500">held back by</span>
                      <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 text-[10px] font-medium">{w.heldBackBy}</span>
                      <button type="button" onClick={() => onAnalyse?.(w.ticker)} className="ml-auto text-slate-500 hover:text-sky-400">
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Avoid */}
            {screen.avoid.length > 0 && (
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Avoid</h3>
                <div className="flex flex-wrap gap-1.5">
                  {screen.avoid.map((a) => (
                    <button
                      key={a.ticker} type="button" onClick={() => onAnalyse?.(a.ticker)}
                      className="px-2 py-1 rounded-lg bg-rose-950/30 border border-rose-900/50 text-[10.5px] text-rose-300 hover:bg-rose-950/50"
                      title={`Composite ${a.compositeScore}, Stage ${a.stage}`}
                    >
                      {a.ticker} <span className="text-rose-500/80">stage {a.stage}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {screen.errors?.length > 0 && (
              <p className="text-[10.5px] text-slate-600">
                {screen.errors.length} symbol{screen.errors.length === 1 ? '' : 's'} could not be screened (data unavailable).
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, tone = 'flat' }) {
  const color = tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-slate-100';
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
