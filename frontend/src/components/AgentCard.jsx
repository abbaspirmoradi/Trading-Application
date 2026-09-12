import React, { useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, Clock, FlaskConical } from 'lucide-react';
import { clusterMeta } from './AgentSelector.jsx';

// Which feed each agent depends on, for provenance labelling. Agents absent
// from this map run purely on price/volume and inherit that feed's provenance.
// Under a live provider every feed is observed; the badge only appears when
// the app is running on the synthetic provider.
const AGENT_INPUT_FEED = {
  Intermarket_Macro_Agent: { feed: 'macro', label: 'macro data' },
};

const SIGNAL_STYLE = {
  BULLISH: 'text-emerald-400 bg-emerald-500/10',
  BEARISH: 'text-rose-400 bg-rose-500/10',
  NEUTRAL: 'text-slate-400 bg-slate-500/10',
};

/** Formats a metric value for display without truncating meaning. */
function formatValue(v) {
  if (v == null) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') return '—';
  return String(v);
}

const humanise = (k) => k
  .replace(/([A-Z])/g, ' $1')
  .replace(/^./, (c) => c.toUpperCase())
  .replace(/\bPct\b/, '%')
  .trim();

/**
 * One agent's contribution: score, signal, its key metrics and the full
 * reasoning trace. Collapsed by default — eleven expanded cards is noise, but
 * every number stays one click away.
 */
export default function AgentCard({ result, contribution, dataSources, caveats = [] }) {
  const [open, setOpen] = useState(false);
  const meta = clusterMeta(result.cluster);
  const Icon = meta.icon;
  const isError = result.status === 'ERROR';

  // Objects and arrays are skipped in the compact grid; they are rendered in
  // the expanded detail sections instead.
  const scalarMetrics = Object.entries(result.metrics || {})
    .filter(([, v]) => v == null || typeof v !== 'object')
    .slice(0, 8);

  // An agent reading a modelled feed is saying something about invented inputs;
  // that has to be visible on the card, not buried in a README.
  const inputFeed = AGENT_INPUT_FEED[result.agentId];
  const modelledInput = inputFeed && dataSources && dataSources[inputFeed.feed] === 'MODELLED';
  // The pattern detector's selectivity, measured across the universe.
  const patternCaveat = result.agentId === 'Chart_Pattern_Agent'
    ? caveats.find((c) => c.appliesTo === 'pattern') : null;

  const scoreColor = result.score > 20 ? 'text-emerald-400'
    : result.score < -20 ? 'text-rose-400' : 'text-slate-300';
  const barColor = result.score > 0 ? 'bg-emerald-500' : 'bg-rose-500';

  return (
    <div className={`panel overflow-hidden transition-colors ${isError ? 'border-rose-900/60' : ''}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-left p-3.5 hover:bg-slate-800/30 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
            <Icon className={`w-3.5 h-3.5 shrink-0 ${meta.accent}`} />
            <span className="text-xs font-semibold text-slate-200 truncate">{result.agentName}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {modelledInput && (
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 text-[9px] font-bold tracking-wide"
                title={`This agent's ${inputFeed.label} ${inputFeed.partial ? 'inputs are partly ' : 'inputs are '}generated, not observed market data.`}
              >
                <FlaskConical className="w-2.5 h-2.5" />
                {inputFeed.partial ? 'PARTLY MODELLED' : 'MODELLED'}
              </span>
            )}
            {isError && <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />}
            <span className={`px-1.5 py-0.5 rounded text-[9.5px] font-bold tracking-wide ${SIGNAL_STYLE[result.signal]}`}>
              {result.signal}
            </span>
          </div>
        </div>

        {/* Score bar with a centre origin */}
        <div className="mt-2.5 flex items-center gap-2.5">
          <span className={`text-lg font-bold tabular-nums w-14 ${scoreColor}`}>
            {result.score > 0 ? '+' : ''}{result.score}
          </span>
          <div className="flex-1 relative h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div className="absolute top-0 h-full w-px bg-slate-600 left-1/2" />
            <div
              className={`absolute top-0 h-full ${barColor} transition-all duration-500`}
              style={{
                left: result.score >= 0 ? '50%' : `${50 + result.score / 2}%`,
                width: `${Math.abs(result.score) / 2}%`,
              }}
            />
          </div>
          <span className="text-[10px] text-slate-500 tabular-nums w-16 text-right">
            conf {(result.confidence * 100).toFixed(0)}%
          </span>
        </div>

        {contribution && (
          <div className="mt-1.5 text-[10px] text-slate-500 flex items-center gap-2 flex-wrap">
            {contribution.directionalVote ? (
              <span>weight {contribution.effectiveWeight} · contribution {contribution.weightedContribution > 0 ? '+' : ''}{contribution.weightedContribution}</span>
            ) : (
              <span className="text-amber-500/80">gatekeeper — does not vote on direction</span>
            )}
          </div>
        )}
      </button>

      {open && (
        <div className="px-3.5 pb-3.5 border-t border-slate-800/70 pt-3 space-y-3">
          {scalarMetrics.length > 0 && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {scalarMetrics.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 text-[10.5px]">
                  <span className="text-slate-500 truncate">{humanise(k)}</span>
                  <span className="text-slate-200 tabular-nums font-medium shrink-0">{formatValue(v)}</span>
                </div>
              ))}
            </div>
          )}

          <div>
            <div className="stat-label mb-1.5">Reasoning</div>
            <ul className="space-y-1">
              {result.reasoning?.map((r, i) => (
                <li key={i} className="text-[11px] text-slate-400 leading-relaxed flex gap-1.5">
                  <span className="text-slate-600 select-none shrink-0">•</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Fractional differentiation sweep — the one metric that deserves its
              own visual, since it shows the memory/stationarity trade-off. */}
          {result.metrics?.dSweep?.length > 0 && (
            <div>
              <div className="stat-label mb-1.5">Stationarity sweep (d vs ADF p-value)</div>
              <div className="flex items-end gap-0.5 h-12">
                {result.metrics.dSweep.map((s) => (
                  <div
                    key={s.d}
                    className={`flex-1 rounded-t ${s.pValue < 0.05 ? 'bg-emerald-500/70' : 'bg-slate-700'}`}
                    style={{ height: `${Math.max(4, (1 - s.pValue) * 100)}%` }}
                    title={`d=${s.d}, p=${s.pValue}, memory=${s.memory}`}
                  />
                ))}
              </div>
              <div className="flex justify-between text-[9px] text-slate-600 mt-0.5">
                <span>d=0.05</span><span>d=1.00</span>
              </div>
            </div>
          )}

          {result.metrics?.correlationMatrix?.length > 0 && (
            <div>
              <div className="stat-label mb-1.5">Correlation to holdings</div>
              <div className="space-y-1">
                {result.metrics.correlationMatrix.map((c) => (
                  <div key={c.ticker} className="flex items-center gap-2 text-[10.5px]">
                    <span className="text-slate-400 w-12 shrink-0">{c.ticker}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full ${Math.abs(c.correlation) > 0.7 ? 'bg-rose-500' : Math.abs(c.correlation) > 0.5 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.abs(c.correlation) * 100}%` }}
                      />
                    </div>
                    <span className="text-slate-300 tabular-nums w-10 text-right shrink-0">{c.correlation}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.metrics?.headlines?.length > 0 && (
            <div>
              <div className="stat-label mb-1.5">News flow</div>
              <div className="space-y-1">
                {result.metrics.headlines.slice(0, 5).map((h, i) => (
                  <div key={i} className="flex items-start gap-2 text-[10.5px]">
                    <span className={`shrink-0 tabular-nums w-10 ${h.sentiment >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {h.sentiment > 0 ? '+' : ''}{h.sentiment.toFixed(2)}
                    </span>
                    <span className="text-slate-400 leading-snug">{h.headline}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {patternCaveat && (
            <p className={`text-[10px] leading-snug ${patternCaveat.severity === 'HIGH' ? 'text-rose-400/90' : patternCaveat.severity === 'MEDIUM' ? 'text-amber-400/80' : 'text-slate-500'}`}>
              {patternCaveat.title}. {patternCaveat.detail}
            </p>
          )}
          {modelledInput && (
            <p className="text-[10px] text-amber-400/80 leading-snug">
              Inputs generated locally: this agent's {inputFeed.label} {inputFeed.partial ? 'are not fully ' : 'are not '}
              real market data. Its reasoning is sound; its premises are simulated.
            </p>
          )}

          <div className="flex items-center gap-1.5 text-[9.5px] text-slate-600">
            <Clock className="w-2.5 h-2.5" /> {result.elapsedMs}ms · {result.agentId}
          </div>
        </div>
      )}
    </div>
  );
}
