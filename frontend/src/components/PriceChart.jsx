import React, { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Line, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';
import { CandlestickChart, Loader2 } from 'lucide-react';
import api from '../services/api.js';

const STAGE_LABEL = { 1: 'Stage 1 — Basing', 2: 'Stage 2 — Advancing', 3: 'Stage 3 — Topping', 4: 'Stage 4 — Declining' };
const STAGE_COLOR = { 1: '#64748b', 2: '#10b981', 3: '#f59e0b', 4: '#f43f5e' };

/**
 * Price chart with the overlays the strategy actually trades on: the 30-week
 * (150-day) moving average that defines the Weinstein stage, the 50-day, the
 * volume histogram, and the live triple-barrier levels from the decision.
 */
export default function PriceChart({ ticker, decision }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState(250);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!ticker) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.chart(ticker, 500)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker]);

  const bars = useMemo(() => (data?.bars || []).slice(-range), [data, range]);

  const stage = decision?.agentBreakdown?.find((a) => a.agentId === 'Weinstein_Stage_Agent')?.payload?.stage;
  const plan = decision?.executionPlan;
  const barriers = decision?.barriers;

  const volumeMax = useMemo(() => Math.max(...bars.map((b) => b.volume), 1), [bars]);
  const priceDomain = useMemo(() => {
    if (!bars.length) return ['auto', 'auto'];
    const lows = bars.map((b) => b.low);
    const his = bars.map((b) => b.high);
    const extra = [plan?.stopLoss, plan?.profitTarget, barriers?.stopLoss, barriers?.profitTarget].filter(Boolean);
    const lo = Math.min(...lows, ...extra);
    const hi = Math.max(...his, ...extra);
    const pad = (hi - lo) * 0.08;
    return [Number((lo - pad).toFixed(2)), Number((hi + pad).toFixed(2))];
  }, [bars, plan, barriers]);

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <CandlestickChart className="w-4 h-4 text-sky-400" />
          <h3 className="text-sm font-semibold text-slate-200">{ticker} — Price &amp; Stage Structure</h3>
          {stage && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ backgroundColor: `${STAGE_COLOR[stage]}20`, color: STAGE_COLOR[stage] }}>
              {STAGE_LABEL[stage]}
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {[120, 250, 500].map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-2 py-1 rounded text-[10.5px] font-medium transition-colors ${
                range === r ? 'bg-slate-700 text-slate-100' : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      <div className="p-3">
        {loading && (
          <div className="h-[340px] flex items-center justify-center text-slate-500 text-sm gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading price history…
          </div>
        )}
        {error && <div className="h-[340px] flex items-center justify-center text-rose-400 text-sm">{error}</div>}

        {!loading && !error && bars.length > 0 && (
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={bars} margin={{ top: 5, right: 60, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} minTickGap={60} axisLine={{ stroke: '#1e293b' }} tickLine={false} />
              <YAxis yAxisId="price" domain={priceDomain} tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} width={55} orientation="right" />
              <YAxis yAxisId="volume" domain={[0, volumeMax * 4]} hide />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 10, color: '#94a3b8' }} iconType="line" />

              <Bar yAxisId="volume" dataKey="volume" fill="#334155" opacity={0.55} name="Volume" isAnimationActive={false} />
              <Area yAxisId="price" dataKey="close" stroke="#38bdf8" strokeWidth={1.6} fill="url(#priceFill)" name="Close" isAnimationActive={false} />
              <Line yAxisId="price" dataKey="ma50" stroke="#a78bfa" strokeWidth={1.2} dot={false} name="50-day MA" isAnimationActive={false} connectNulls />
              <Line yAxisId="price" dataKey="ma150" stroke="#fbbf24" strokeWidth={1.6} dot={false} name="30-week MA (150d)" isAnimationActive={false} connectNulls />

              <defs>
                <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                </linearGradient>
              </defs>

              {/* Triple-barrier overlays from the live decision */}
              {plan?.profitTarget && (
                <ReferenceLine yAxisId="price" y={plan.profitTarget} stroke="#10b981" strokeDasharray="5 4"
                  label={{ value: `Target ${plan.profitTarget}`, position: 'right', fill: '#10b981', fontSize: 9 }} />
              )}
              {plan?.profitTarget1 && (
                <ReferenceLine yAxisId="price" y={plan.profitTarget1} stroke="#10b981" strokeDasharray="2 4" opacity={0.6}
                  label={{ value: `T1 ${plan.profitTarget1}`, position: 'right', fill: '#10b981', fontSize: 9 }} />
              )}
              {plan?.triggerPrice && plan.orderType !== 'NONE' && (
                <ReferenceLine yAxisId="price" y={plan.triggerPrice} stroke="#38bdf8" strokeDasharray="5 4"
                  label={{ value: `Trigger ${plan.triggerPrice}`, position: 'right', fill: '#38bdf8', fontSize: 9 }} />
              )}
              {plan?.stopLoss && (
                <ReferenceLine yAxisId="price" y={plan.stopLoss} stroke="#f43f5e" strokeDasharray="5 4"
                  label={{ value: `Stop ${plan.stopLoss}`, position: 'right', fill: '#f43f5e', fontSize: 9 }} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const bar = payload[0].payload;
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-[11px] shadow-xl">
      <div className="text-slate-300 font-semibold mb-1">{label}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
        <span className="text-slate-500">Open</span><span className="text-slate-200">{bar.open?.toFixed(2)}</span>
        <span className="text-slate-500">High</span><span className="text-slate-200">{bar.high?.toFixed(2)}</span>
        <span className="text-slate-500">Low</span><span className="text-slate-200">{bar.low?.toFixed(2)}</span>
        <span className="text-slate-500">Close</span><span className="text-slate-100 font-semibold">{bar.close?.toFixed(2)}</span>
        <span className="text-slate-500">Volume</span><span className="text-slate-200">{(bar.volume / 1e6).toFixed(2)}M</span>
        {bar.ma150 && (<><span className="text-amber-500/80">30w MA</span><span className="text-amber-400">{bar.ma150.toFixed(2)}</span></>)}
      </div>
    </div>
  );
}
