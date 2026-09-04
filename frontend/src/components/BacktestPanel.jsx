import React, { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { FlaskConical, Loader2, ShieldCheck, ShieldX, ShieldAlert } from 'lucide-react';
import api from '../services/api.js';

const VERDICT = {
  VALIDATED: { icon: ShieldCheck, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-700/50' },
  MARGINAL: { icon: ShieldAlert, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-700/50' },
  SPURIOUS: { icon: ShieldX, color: 'text-rose-400', bg: 'bg-rose-500/10 border-rose-700/50' },
};

/**
 * Walk-forward backtest with a Monte Carlo permutation test. The permutation
 * verdict matters more than the return: it answers "would this rule have earned
 * this much on shuffled noise?".
 */
export default function BacktestPanel({ ticker }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const { backtest } = await api.backtest(ticker, 200);
      setResult(backtest);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const oos = result?.outOfSample;
  const perm = result?.permutationTest;
  const V = perm ? VERDICT[perm.verdict] : null;

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-violet-400" />
          <h3 className="text-sm font-semibold text-slate-200">Walk-Forward Audit — {ticker}</h3>
        </div>
        <button type="button" className="btn-ghost flex items-center gap-1.5" onClick={run} disabled={loading || !ticker}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
          {loading ? 'Running…' : 'Run backtest'}
        </button>
      </div>

      <div className="p-4">
        {error && <div className="text-xs text-rose-400">{error}</div>}

        {!result && !loading && !error && (
          <p className="text-xs text-slate-500 leading-relaxed">
            Runs the primary trend + relative-strength rule over rolling walk-forward folds with triple-barrier exits,
            reporting out-of-sample statistics only. A Monte Carlo permutation test then re-runs the identical rule on
            shuffled returns to establish whether the edge survives a data-snooping control.
          </p>
        )}

        {result && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="OOS trades" value={oos.trades} />
              <Stat label="Win rate" value={`${oos.winRate}%`} tone={oos.winRate > 50 ? 'pos' : 'neg'} />
              <Stat label="OOS return" value={`${oos.totalReturnPct}%`} tone={oos.totalReturnPct > 0 ? 'pos' : 'neg'} />
              <Stat label="Sharpe" value={oos.sharpe} tone={oos.sharpe > 1 ? 'pos' : 'flat'} />
              <Stat label="Max drawdown" value={`${oos.maxDrawdownPct}%`} tone="neg" />
              <Stat label="Profit factor" value={oos.profitFactor} />
              <Stat label="Avg R multiple" value={oos.avgRMultiple} tone={oos.avgRMultiple > 0 ? 'pos' : 'neg'} />
              <Stat label="Folds" value={result.folds.length} />
            </div>

            {perm && (
              <div className={`p-3 rounded-lg border ${V.bg}`}>
                <div className="flex items-center gap-2 mb-1.5">
                  <V.icon className={`w-4 h-4 ${V.color}`} />
                  <span className={`text-xs font-bold ${V.color}`}>PERMUTATION TEST: {perm.verdict}</span>
                  <span className="text-[11px] text-slate-400 tabular-nums">p = {perm.pValue}</span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">{perm.interpretation}</p>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[10.5px] text-slate-400 tabular-nums">
                  <span>Observed: <span className="text-slate-200">{perm.observedReturnPct}%</span></span>
                  <span>Null mean: <span className="text-slate-200">{perm.nullMeanReturnPct}%</span></span>
                  <span>Null σ: <span className="text-slate-200">{perm.nullStdevPct}%</span></span>
                  <span>z: <span className="text-slate-200">{perm.zScore}</span></span>
                  <span>{perm.permutations} permutations</span>
                </div>
              </div>
            )}

            <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-slate-400">
                <span>In-sample return: <span className="text-slate-200 tabular-nums">{result.degradation.inSampleReturnPct}%</span></span>
                <span>Out-of-sample: <span className="text-slate-200 tabular-nums">{result.degradation.outOfSampleReturnPct}%</span></span>
                <span>
                  Degradation:{' '}
                  <span className={`tabular-nums ${result.degradation.degradationPct > 20 ? 'text-rose-400' : 'text-slate-200'}`}>
                    {result.degradation.degradationPct}%
                  </span>
                </span>
                <span className="text-slate-500">
                  Barriers hit — profit {oos.barrierBreakdown?.PROFIT ?? 0} / stop {oos.barrierBreakdown?.STOP ?? 0} / time {oos.barrierBreakdown?.TIME ?? 0}
                </span>
              </div>
            </div>

            {oos.equityCurve?.length > 1 && (
              <div>
                <div className="stat-label mb-2">Out-of-sample equity curve (compounded, per closed trade)</div>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={oos.equityCurve}>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 9 }} minTickGap={40} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} domain={['auto', 'auto']} width={45} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                      formatter={(v) => [`${((v - 1) * 100).toFixed(2)}%`, 'Cumulative']}
                    />
                    <ReferenceLine y={1} stroke="#475569" strokeDasharray="3 3" />
                    <Line dataKey="equity" stroke="#a78bfa" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'flat' }) {
  const color = tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-slate-100';
  return (
    <div className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800">
      <div className="stat-label">{label}</div>
      <div className={`text-sm font-bold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
