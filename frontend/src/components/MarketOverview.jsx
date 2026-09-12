import React from 'react';
import { Activity, Wifi, WifiOff, FlaskConical, Radio } from 'lucide-react';

const cls = (v) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-400');

/**
 * Watchlist strip plus the macro regime bar. Quotes update live over the
 * WebSocket; the macro block is what the Intermarket agent is reading.
 */
export default function MarketOverview({ quotes = [], macro, selected, onSelect, socketStatus, provider, macroSource, macroNote }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-sky-400" />
          <h3 className="text-sm font-semibold text-slate-200">Market Overview</h3>
        </div>
        <div className="flex items-center gap-3 text-[10.5px]">
          <ProvenanceBadge provider={provider} />
          {socketStatus === 'connected'
            ? <><Wifi className="w-3 h-3 text-emerald-400" /><span className="text-emerald-400">live</span></>
            : <><WifiOff className="w-3 h-3 text-slate-500" /><span className="text-slate-500">{socketStatus}</span></>}
        </div>
      </div>

      <div className="p-3 flex gap-2 overflow-x-auto">
        {quotes.map((q) => (
          <button
            key={q.ticker}
            type="button"
            onClick={() => onSelect(q.ticker)}
            className={`shrink-0 px-3 py-2 rounded-lg border transition-colors min-w-[104px] text-left ${
              selected === q.ticker
                ? 'bg-slate-800 border-sky-600/60 ring-1 ring-sky-500/30'
                : 'bg-slate-900/50 border-slate-800 hover:bg-slate-800/60'
            }`}
          >
            <div className="text-xs font-semibold text-slate-200">{q.ticker}</div>
            <div className="text-sm font-bold tabular-nums text-slate-100">{q.price?.toFixed(2)}</div>
            <div className={`text-[10.5px] tabular-nums ${cls(q.changePercent)}`}>
              {q.changePercent > 0 ? '+' : ''}{q.changePercent?.toFixed(2)}%
            </div>
          </button>
        ))}
        {quotes.length === 0 && <div className="text-xs text-slate-500 p-2">Loading quotes…</div>}
      </div>

      {macro && (
        <div className="px-3 pb-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[10.5px] border-t border-slate-800 pt-2.5">
          {macroSource === 'LIVE' ? (
            <span className="flex items-center gap-1 text-emerald-400/90" title={macroNote || 'Live macro data.'}>
              <Radio className="w-2.5 h-2.5" /> live
            </span>
          ) : (
            <span className="flex items-center gap-1 text-amber-400/90" title={macroNote || 'These macro values are generated locally.'}>
              <FlaskConical className="w-2.5 h-2.5" /> modelled
            </span>
          )}
          <MacroStat label="10Y" value={`${macro.tnx}%`} delta={macro.tnxChange20d} invert />
          <MacroStat label="DXY" value={macro.dxy} delta={macro.dxyChange20d} invert />
          <MacroStat label="VIX" value={macro.vix} tone={macro.vix > 25 ? 'neg' : macro.vix < 15 ? 'pos' : 'flat'} />
          <MacroStat label="VXN" value={macro.vxn} tone={macro.vxn > 28 ? 'neg' : 'flat'} />
          <MacroStat label="3m/10y" value={`${macro.yieldCurve3m10s}%`} tone={macro.yieldCurve3m10s < 0 ? 'neg' : 'pos'} />
          <MacroStat label="Credit stress" value={macro.creditStressProxy} tone={macro.creditStressProxy > 1 ? 'neg' : 'flat'} />
          {macro.percentAboveMa50 != null && macro.sampleSize > 0 && (
            <MacroStat label="Above 50d MA" value={`${macro.percentAboveMa50}%`} tone={macro.percentAboveMa50 > 55 ? 'pos' : macro.percentAboveMa50 < 35 ? 'neg' : 'flat'} />
          )}
          <MacroStat label="NH-NL" value={macro.newHighsMinusLows} tone={macro.newHighsMinusLows > 0 ? 'pos' : 'neg'} />
          <MacroStat label="Oil" value={macro.oil} />
          <MacroStat label="Gold" value={macro.gold} />
        </div>
      )}
    </div>
  );
}

function ProvenanceBadge({ provider }) {
  const live = provider === 'yahoo';
  return (
    <span
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold tracking-wide ${
        live ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
      }`}
      title={live
        ? 'Prices, volume and macro are real daily data from Yahoo Finance (last completed session). Every agent runs on observed inputs.'
        : 'All data is generated locally. No figure on this screen reflects a real market.'}
    >
      {live ? <Radio className="w-2.5 h-2.5" /> : <FlaskConical className="w-2.5 h-2.5" />}
      {live ? 'PRICES LIVE' : 'SIMULATED DATA'}
    </span>
  );
}

function MacroStat({ label, value, delta, tone = 'flat', invert = false }) {
  const color = tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-slate-200';
  const deltaColor = delta == null ? '' : (invert ? -delta : delta) > 0 ? 'text-emerald-500' : 'text-rose-500';
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-slate-500">{label}</span>
      <span className={`font-semibold tabular-nums ${color}`}>{value}</span>
      {delta != null && (
        <span className={`tabular-nums ${deltaColor}`}>({delta > 0 ? '+' : ''}{delta})</span>
      )}
    </span>
  );
}
