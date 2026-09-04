import React, { useMemo } from 'react';
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer,
} from 'recharts';
import { Users, Network } from 'lucide-react';
import AgentCard from './AgentCard.jsx';
import ExecutiveDecisionCard from './ExecutiveDecisionCard.jsx';
import PriceChart from './PriceChart.jsx';

const CLUSTER_LABEL = {
  FUNDAMENTAL: 'Fundamental', TECHNICAL: 'Technical', QUANT: 'Quant',
  MACRO: 'Macro', SENTIMENT: 'Sentiment', RISK: 'Risk', EXECUTION: 'Execution',
};

/**
 * The analysis cockpit: the manager's verdict, the price structure, the
 * cluster-level consensus radar, and every individual agent's contribution.
 */
export default function AnalysisDashboard({ decision, ticker }) {
  const contributionById = useMemo(() => Object.fromEntries(
    (decision?.consensus?.contributions || []).map((c) => [c.agentId, c]),
  ), [decision]);

  const radarData = useMemo(() => {
    const scores = decision?.consensus?.clusterScores || {};
    return Object.entries(scores).map(([cluster, score]) => ({
      cluster: CLUSTER_LABEL[cluster] || cluster,
      // Radar axes cannot render negatives; map [-100,100] onto [0,100] with 50
      // as the neutral midpoint and label the true score in the tooltip.
      value: Number(((score + 100) / 2).toFixed(1)),
      raw: score,
    }));
  }, [decision]);

  if (!decision) return null;

  // Voters first, sorted by absolute impact; gatekeepers last.
  const sorted = [...(decision.agentBreakdown || [])].sort((a, b) => {
    const aGate = a.cluster === 'RISK' || a.cluster === 'EXECUTION';
    const bGate = b.cluster === 'RISK' || b.cluster === 'EXECUTION';
    if (aGate !== bGate) return aGate ? 1 : -1;
    return Math.abs(b.score) - Math.abs(a.score);
  });

  return (
    <div className="space-y-4">
      <ExecutiveDecisionCard decision={decision} />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2">
          <PriceChart ticker={ticker} decision={decision} />
        </div>

        <div className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Network className="w-4 h-4 text-violet-400" />
              <h3 className="text-sm font-semibold text-slate-200">Cluster Consensus</h3>
            </div>
          </div>
          <div className="p-3">
            {radarData.length >= 3 ? (
              <ResponsiveContainer width="100%" height={230}>
                <RadarChart data={radarData} outerRadius="72%">
                  <PolarGrid stroke="#1e293b" />
                  <PolarAngleAxis dataKey="cluster" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                  <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                  <Radar dataKey="value" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.35} isAnimationActive={false} />
                </RadarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[230px] flex items-center justify-center text-xs text-slate-500 text-center px-4">
                Activate agents across at least three clusters to plot the consensus radar.
              </div>
            )}

            <div className="mt-2 space-y-1.5 border-t border-slate-800 pt-3">
              {radarData.map((d) => (
                <div key={d.cluster} className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-400">{d.cluster}</span>
                  <span className={`tabular-nums font-semibold ${d.raw > 15 ? 'text-emerald-400' : d.raw < -15 ? 'text-rose-400' : 'text-slate-300'}`}>
                    {d.raw > 0 ? '+' : ''}{d.raw}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-3 pt-3 border-t border-slate-800 grid grid-cols-3 gap-2 text-center">
              <VoteStat label="Bullish" value={decision.consensus?.bullishCount ?? 0} color="text-emerald-400" />
              <VoteStat label="Neutral" value={decision.consensus?.neutralCount ?? 0} color="text-slate-400" />
              <VoteStat label="Bearish" value={decision.consensus?.bearishCount ?? 0} color="text-rose-400" />
            </div>
            {decision.consensus?.dispersion != null && (
              <p className="mt-2 text-[10.5px] text-slate-500 text-center">
                Score dispersion {decision.consensus.dispersion} · {decision.consensus.gatekeeperCount} gatekeeper
                {decision.consensus.gatekeeperCount === 1 ? '' : 's'} excluded from the vote
              </p>
            )}
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-2.5">
          <Users className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-300">Agent Breakdown</h3>
          <span className="text-[11px] text-slate-500">
            {decision.completedAgentCount} of {decision.activeAgentCount} reported
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {sorted.map((result) => (
            <AgentCard
              key={result.agentId}
              result={result}
              contribution={contributionById[result.agentId]}
              dataSources={decision.dataSources}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function VoteStat({ label, value, color }) {
  return (
    <div>
      <div className={`text-base font-bold tabular-nums ${color}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
