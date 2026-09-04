import React from 'react';
import {
  ShieldAlert, TrendingUp, TrendingDown, Minus, Target, Ban,
  Crosshair, Layers, Gauge,
} from 'lucide-react';

const ACTION_STYLES = {
  STRONG_BUY: { bg: 'from-emerald-600/25 to-emerald-500/5', border: 'border-emerald-500/50', text: 'text-emerald-300', Icon: TrendingUp, label: 'Strong Buy' },
  BUY: { bg: 'from-emerald-600/15 to-emerald-500/5', border: 'border-emerald-600/40', text: 'text-emerald-400', Icon: TrendingUp, label: 'Buy' },
  HOLD: { bg: 'from-amber-600/15 to-amber-500/5', border: 'border-amber-600/40', text: 'text-amber-400', Icon: Minus, label: 'Hold' },
  REDUCE: { bg: 'from-orange-600/15 to-orange-500/5', border: 'border-orange-600/40', text: 'text-orange-400', Icon: TrendingDown, label: 'Reduce' },
  SELL: { bg: 'from-rose-600/20 to-rose-500/5', border: 'border-rose-600/50', text: 'text-rose-400', Icon: TrendingDown, label: 'Sell' },
  SHORT: { bg: 'from-rose-600/25 to-rose-500/5', border: 'border-rose-500/50', text: 'text-rose-300', Icon: TrendingDown, label: 'Short' },
};

const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const px = (n) => (n == null ? '—' : Number(n).toFixed(2));

/**
 * The manager's synthesised verdict: action, conviction, sizing and the full
 * execution contract. Deliberately loud — this is the one component a trader
 * looks at before committing capital.
 */
export default function ExecutiveDecisionCard({ decision }) {
  if (!decision) return null;

  const style = ACTION_STYLES[decision.finalAction] || ACTION_STYLES.HOLD;
  const { Icon } = style;
  const plan = decision.executionPlan || {};
  const sizing = decision.positionSizing || {};
  const blockingVeto = decision.vetoesTriggered?.find((v) => v.severity === 'BLOCK');

  return (
    <div className={`panel bg-gradient-to-br ${style.bg} ${style.border} border`}>
      {/* Banner */}
      <div className="p-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className={`p-3 rounded-xl bg-slate-900/60 ${style.text}`}>
            <Icon className="w-7 h-7" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-2xl font-bold text-slate-100 tracking-tight">{decision.ticker}</h2>
              <span className="text-lg text-slate-400 tabular-nums">{px(decision.price)}</span>
            </div>
            <div className={`mt-0.5 text-xl font-bold ${style.text}`}>{style.label}</div>
            <div className="mt-1 text-[11px] text-slate-500">
              {decision.completedAgentCount}/{decision.activeAgentCount} agents reported · {decision.elapsedMs}ms · {decision.asOf}
            </div>
          </div>
        </div>

        <div className="flex gap-5">
          <Metric label="Composite" value={`${decision.compositeScore > 0 ? '+' : ''}${decision.compositeScore}`} tone={decision.compositeScore > 0 ? 'pos' : decision.compositeScore < 0 ? 'neg' : 'flat'} />
          <Metric label="Confidence" value={`${(decision.confidence * 100).toFixed(0)}%`} />
          <Metric label="P(profit)" value={`${(decision.probabilityOfProfit * 100).toFixed(1)}%`} tone={decision.probabilityOfProfit > 0.55 ? 'pos' : decision.probabilityOfProfit < 0.45 ? 'neg' : 'flat'} />
        </div>
      </div>

      {/* Conviction + agreement gauges */}
      <div className="px-5 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <Gauge2
          label="Composite conviction"
          value={decision.compositeScore}
          min={-100}
          max={100}
          format={(v) => `${v > 0 ? '+' : ''}${v}`}
        />
        <Gauge2
          label="Directional agreement"
          value={Math.round((decision.consensus?.agreement ?? 0) * 100)}
          min={0}
          max={100}
          format={(v) => `${v}%`}
          neutralColor
        />
      </div>

      {/* Vetoes */}
      {decision.vetoesTriggered?.length > 0 && (
        <div className="px-5 pb-4 space-y-2">
          {decision.vetoesTriggered.map((v) => (
            <div
              key={v.code}
              className={`flex items-start gap-2.5 p-3 rounded-lg border text-xs ${
                v.severity === 'BLOCK'
                  ? 'bg-rose-950/40 border-rose-800/60 text-rose-200'
                  : 'bg-amber-950/30 border-amber-800/50 text-amber-200'
              }`}
            >
              {v.severity === 'BLOCK' ? <Ban className="w-4 h-4 shrink-0 mt-0.5" /> : <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />}
              <div>
                <span className="font-semibold tracking-wide">{v.code}</span>
                <span className="ml-2 opacity-60 text-[10px] uppercase">
                  {v.severity === 'BLOCK' ? 'blocking' : `size × ${v.sizeMultiplier}`}
                </span>
                <p className="mt-0.5 opacity-90 leading-snug">{v.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {decision.blocked && !blockingVeto && decision.blockReason && (
        <div className="px-5 pb-4">
          <div className="flex items-start gap-2.5 p-3 rounded-lg border bg-slate-800/50 border-slate-700 text-xs text-slate-300">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <p>{decision.blockReason}</p>
          </div>
        </div>
      )}

      {/* Sizing + execution plan */}
      <div className="grid grid-cols-1 lg:grid-cols-2 border-t border-slate-800/80">
        <div className="p-5 border-b lg:border-b-0 lg:border-r border-slate-800/80">
          <SectionTitle icon={Layers}>Position Sizing — Fractional Kelly</SectionTitle>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="Suggested shares" value={sizing.suggestedShares ?? 0} big />
            <Field label="Allocation" value={usd(sizing.allocationDollar)} big />
            <Field label="% of equity" value={`${sizing.portfolioPercent ?? 0}%`} />
            <Field label="Dollar at risk" value={`${usd(sizing.actualRiskDollar)} (${sizing.actualRiskPercent ?? 0}%)`} />
            <Field label="Full Kelly f*" value={sizing.fullKelly != null ? `${(sizing.fullKelly * 100).toFixed(1)}%` : '—'} />
            <Field label={`Fractional (${sizing.kellyFraction ?? 0.25}×)`} value={sizing.fractionalKelly != null ? `${(sizing.fractionalKelly * 100).toFixed(2)}%` : '—'} />
          </div>
          {sizing.bindingConstraint && (
            <p className="mt-3 text-[11px] text-slate-500">
              Binding constraint: <span className="text-slate-300 font-medium">{sizing.bindingConstraint}</span>
              {sizing.sizeMultiplierFromVetoes != null && sizing.sizeMultiplierFromVetoes < 1 && (
                <span className="text-amber-400"> · veto multiplier ×{sizing.sizeMultiplierFromVetoes}</span>
              )}
            </p>
          )}
        </div>

        <div className="p-5">
          <SectionTitle icon={Crosshair}>Execution Plan &amp; Triple Barrier</SectionTitle>
          {plan.orderType && plan.orderType !== 'NONE' ? (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Field label="Order type" value={plan.orderType} />
                <Field label="Reward : risk" value={plan.riskRewardRatio ? `${plan.riskRewardRatio}:1` : '—'} />
                <Field label="Trigger" value={px(plan.triggerPrice)} />
                <Field label="Limit" value={px(plan.limitPrice)} />
                <Field label="Stop loss" value={px(plan.stopLoss)} tone="neg" />
                <Field label="Target 1 / 2" value={`${px(plan.profitTarget1)} / ${px(plan.profitTarget)}`} tone="pos" />
                <Field label="Time barrier" value={plan.timeBarrier ?? '—'} />
                <Field label="Max slippage" value={plan.maxSlippageBps != null ? `${plan.maxSlippageBps} bps` : '—'} />
              </div>
              {plan.stopBasis && (
                <p className="mt-3 text-[11px] text-slate-500">Stop basis: <span className="text-slate-300">{plan.stopBasis}</span></p>
              )}
              {plan.entryNote && <p className="mt-1 text-[11px] text-slate-500 leading-snug">{plan.entryNote}</p>}
            </>
          ) : (
            <div className="text-xs text-slate-400 space-y-2">
              <p>{plan.note || 'No order generated for this decision.'}</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 pt-1">
                <Field label="Watch trigger" value={px(plan.watchTrigger)} />
                <Field label="Reference stop" value={px(plan.stopLoss)} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Executive summary */}
      <div className="p-5 border-t border-slate-800/80">
        <SectionTitle icon={Target}>Executive Summary</SectionTitle>
        <ul className="space-y-1.5">
          {decision.executiveSummary?.map((line, i) => (
            <li key={i} className="text-xs text-slate-300 leading-relaxed flex gap-2">
              <span className="text-slate-600 select-none">▸</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Meta-model transparency */}
      {decision.metaLabel && (
        <div className="px-5 pb-5">
          <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
            <div className="flex items-center gap-2 mb-2">
              <Gauge className="w-3.5 h-3.5 text-violet-400" />
              <span className="text-[11px] font-semibold text-slate-300">Meta-Model ({decision.metaLabel.method})</span>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-[11px] text-slate-400">
              <span>Raw p: <span className="text-slate-200 tabular-nums">{decision.metaLabel.probability}</span></span>
              <span>Training labels: <span className="text-slate-200 tabular-nums">{decision.metaLabel.trainingSamples}</span></span>
              <span>Base rate: <span className="text-slate-200 tabular-nums">{decision.metaLabel.baseRate}</span></span>
              {decision.metaLabel.inSampleAccuracy != null && (
                <span>Accuracy: <span className="text-slate-200 tabular-nums">{(decision.metaLabel.inSampleAccuracy * 100).toFixed(1)}%</span></span>
              )}
              {decision.metaLabel.brierScore != null && (
                <span>Brier: <span className="text-slate-200 tabular-nums">{decision.metaLabel.brierScore}</span></span>
              )}
            </div>
            {decision.metaLabel.featureImportance?.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {decision.metaLabel.featureImportance.slice(0, 5).map((f) => (
                  <span
                    key={f.feature}
                    className={`px-1.5 py-0.5 rounded text-[10px] tabular-nums ${
                      f.contribution > 0 ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'
                    }`}
                    title={`value ${f.value}, weight ${f.weight}`}
                  >
                    {f.feature} {f.contribution > 0 ? '+' : ''}{f.contribution}
                  </span>
                ))}
              </div>
            )}
            {decision.metaLabel.note && <p className="mt-2 text-[10.5px] text-slate-500">{decision.metaLabel.note}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionTitle({ icon: Icon, children }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-3.5 h-3.5 text-slate-500" />
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{children}</h3>
    </div>
  );
}

function Metric({ label, value, tone = 'flat' }) {
  const color = tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-slate-200';
  return (
    <div className="text-right">
      <div className="stat-label">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function Field({ label, value, big = false, tone = 'flat' }) {
  const color = tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-slate-100';
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`${big ? 'text-base' : 'text-sm'} font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

/** Horizontal bar gauge with a centre origin for signed values. */
function Gauge2({ label, value, min, max, format, neutralColor = false }) {
  const span = max - min;
  const pct = ((value - min) / span) * 100;
  const zeroPct = ((0 - min) / span) * 100;
  const signed = min < 0;

  const color = neutralColor
    ? 'bg-sky-500'
    : value > 0 ? 'bg-emerald-500' : value < 0 ? 'bg-rose-500' : 'bg-slate-500';

  const left = signed ? Math.min(pct, zeroPct) : 0;
  const width = signed ? Math.abs(pct - zeroPct) : pct;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="stat-label">{label}</span>
        <span className="text-xs font-semibold tabular-nums text-slate-200">{format(value)}</span>
      </div>
      <div className="relative h-2 rounded-full bg-slate-800 overflow-hidden">
        <div className={`absolute top-0 h-full ${color} transition-all duration-500`} style={{ left: `${left}%`, width: `${width}%` }} />
        {signed && <div className="absolute top-0 h-full w-px bg-slate-600" style={{ left: `${zeroPct}%` }} />}
      </div>
    </div>
  );
}
