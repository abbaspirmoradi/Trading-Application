import React from 'react';
import {
  CheckCircle2, Circle, Loader2, AlertTriangle, TrendingUp, BarChart3,
  Sigma, Globe, MessageSquare, Shield, Target, Zap, RotateCcw, CheckCheck, XCircle,
} from 'lucide-react';
import { useAgents } from '../context/AgentContext.jsx';

const CLUSTER_META = {
  FUNDAMENTAL: { label: 'Fundamental', icon: TrendingUp, accent: 'text-sky-400', ring: 'ring-sky-500/40', bg: 'bg-sky-500/10' },
  TECHNICAL: { label: 'Technical', icon: BarChart3, accent: 'text-emerald-400', ring: 'ring-emerald-500/40', bg: 'bg-emerald-500/10' },
  QUANT: { label: 'Quantitative', icon: Sigma, accent: 'text-violet-400', ring: 'ring-violet-500/40', bg: 'bg-violet-500/10' },
  MACRO: { label: 'Macro', icon: Globe, accent: 'text-amber-400', ring: 'ring-amber-500/40', bg: 'bg-amber-500/10' },
  SENTIMENT: { label: 'Sentiment', icon: MessageSquare, accent: 'text-pink-400', ring: 'ring-pink-500/40', bg: 'bg-pink-500/10' },
  RISK: { label: 'Risk', icon: Shield, accent: 'text-rose-400', ring: 'ring-rose-500/40', bg: 'bg-rose-500/10' },
  EXECUTION: { label: 'Execution', icon: Target, accent: 'text-cyan-400', ring: 'ring-cyan-500/40', bg: 'bg-cyan-500/10' },
};

export function clusterMeta(cluster) {
  return CLUSTER_META[cluster] || { label: cluster, icon: Zap, accent: 'text-slate-400', ring: 'ring-slate-600', bg: 'bg-slate-700/20' };
}

/**
 * Agent control panel. Every agent is individually toggleable; the run status
 * of the last analysis is surfaced on each card so a failing agent is visible
 * rather than silently absent from the consensus.
 */
export default function AgentSelector({ runStatus = {}, running = false }) {
  const {
    agents, activeIds, activeCount, totalCount, isActive,
    toggle, selectAll, clearAll, resetToDefault, selectCluster, loading, error,
  } = useAgents();

  const clusters = [...new Set(agents.map((a) => a.cluster))];

  if (loading) {
    return (
      <div className="panel p-6 flex items-center gap-3 text-slate-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading agent registry…
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel p-6 flex items-center gap-3 text-rose-400 text-sm">
        <AlertTriangle className="w-4 h-4" /> Could not load agents: {error}
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-header flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Zap className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-slate-200">Agent Control Panel</h2>
          <span
            className={`px-2 py-0.5 rounded-full text-[11px] font-semibold tabular-nums ${
              activeCount === 0 ? 'bg-rose-500/15 text-rose-300'
                : activeCount < 3 ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-emerald-500/15 text-emerald-300'
            }`}
          >
            {activeCount} of {totalCount} Agents Active
          </span>
          {activeCount > 0 && activeCount < 3 && (
            <span className="text-[11px] text-amber-400/90">Quorum needs at least 3</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost flex items-center gap-1.5" onClick={selectAll} disabled={activeCount === totalCount}>
            <CheckCheck className="w-3.5 h-3.5" /> Select All
          </button>
          <button type="button" className="btn-ghost flex items-center gap-1.5" onClick={resetToDefault}>
            <RotateCcw className="w-3.5 h-3.5" /> Reset
          </button>
          <button type="button" className="btn-ghost flex items-center gap-1.5" onClick={clearAll} disabled={activeCount === 0}>
            <XCircle className="w-3.5 h-3.5" /> Clear All
          </button>
        </div>
      </div>

      {/* Cluster shortcuts */}
      <div className="px-4 pt-3 flex flex-wrap gap-1.5">
        {clusters.map((c) => {
          const meta = clusterMeta(c);
          const inCluster = agents.filter((a) => a.cluster === c);
          const onCount = inCluster.filter((a) => isActive(a.agentId)).length;
          const Icon = meta.icon;
          return (
            <button
              key={c}
              type="button"
              onClick={() => selectCluster(c)}
              className={`px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1.5 border transition-colors ${
                onCount === inCluster.length
                  ? `${meta.bg} ${meta.accent} border-transparent`
                  : 'bg-slate-800/50 text-slate-400 border-slate-800 hover:bg-slate-800'
              }`}
              title={`Toggle the entire ${meta.label} cluster`}
            >
              <Icon className="w-3 h-3" />
              {meta.label}
              <span className="tabular-nums opacity-70">{onCount}/{inCluster.length}</span>
            </button>
          );
        })}
      </div>

      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
        {agents.map((agent) => {
          const on = isActive(agent.agentId);
          const meta = clusterMeta(agent.cluster);
          const Icon = meta.icon;
          const status = runStatus[agent.agentId];

          return (
            <button
              key={agent.agentId}
              type="button"
              onClick={() => toggle(agent.agentId)}
              aria-pressed={on}
              className={`text-left p-3 rounded-lg border transition-all group ${
                on
                  ? `bg-slate-800/70 border-slate-700 ring-1 ${meta.ring}`
                  : 'bg-slate-900/40 border-slate-800/70 opacity-55 hover:opacity-80'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className={`w-3.5 h-3.5 shrink-0 ${on ? meta.accent : 'text-slate-600'}`} />
                  <span className="text-xs font-semibold text-slate-200 truncate">{agent.name}</span>
                </div>
                {on
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  : <Circle className="w-4 h-4 text-slate-600 shrink-0" />}
              </div>

              <p className="mt-1.5 text-[10.5px] leading-snug text-slate-500 line-clamp-2">{agent.description}</p>

              <div className="mt-2 flex items-center justify-between">
                <span className={`text-[9.5px] uppercase tracking-wider font-semibold ${on ? meta.accent : 'text-slate-600'}`}>
                  {meta.label}
                </span>
                <AgentStatusPill on={on} running={running} status={status} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AgentStatusPill({ on, running, status }) {
  if (!on) return <span className="text-[9.5px] text-slate-600 font-medium">INACTIVE</span>;
  if (running) {
    return (
      <span className="text-[9.5px] text-sky-400 font-medium flex items-center gap-1">
        <Loader2 className="w-2.5 h-2.5 animate-spin" /> COMPUTING
      </span>
    );
  }
  if (status === 'ERROR') {
    return (
      <span className="text-[9.5px] text-rose-400 font-medium flex items-center gap-1">
        <AlertTriangle className="w-2.5 h-2.5" /> ERROR
      </span>
    );
  }
  if (status === 'COMPLETE') return <span className="text-[9.5px] text-emerald-400 font-medium">COMPLETE</span>;
  return <span className="text-[9.5px] text-slate-500 font-medium">READY</span>;
}
