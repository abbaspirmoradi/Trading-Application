// Agent registry — the single source of truth for which agents exist.
// The UI builds its toggle grid from `listAgents()`, and the orchestrator
// instantiates only the ids the user left active. Adding an agent from the
// wider taxonomy means writing the class and adding one line here.

import {
  WeinsteinStageAgent, ChartPatternAgent, VolumeOrderFlowAgent, RelativeStrengthAgent,
} from './TechnicalAgents.js';
import { FractionalQuantAgent } from './QuantAgents.js';
import { IntermarketMacroAgent } from './MacroSentimentAgents.js';
import { PortfolioRiskAgent, TripleBarrierExitAgent } from './RiskAgents.js';

// Every agent here runs on observed market data when the provider is live.
// Agents that depended on fundamentals, options chains or news feeds were
// removed rather than left running on generated inputs: a coherent argument
// from simulated premises is worse than no argument at all.
const CLASSES = [
  WeinsteinStageAgent,
  ChartPatternAgent,
  VolumeOrderFlowAgent,
  RelativeStrengthAgent,
  FractionalQuantAgent,
  IntermarketMacroAgent,
  PortfolioRiskAgent,
  TripleBarrierExitAgent,
];

// Baseline consensus weights. These are the priors the dynamic
// performance-weighting layer adjusts at run time.
const BASE_WEIGHTS = {
  Weinstein_Stage_Agent: 1.4,
  Chart_Pattern_Agent: 1.1,
  Volume_OrderFlow_Agent: 1.2,
  Relative_Strength_Agent: 1.3,
  Fractional_Quant_Agent: 0.9,
  Intermarket_Macro_Agent: 1.0,
  Portfolio_Risk_Agent: 1.0,
  Triple_Barrier_Exit_Agent: 0.6,
};

const instances = CLASSES.map((C) => {
  const a = new C();
  a.weight = BASE_WEIGHTS[a.id] ?? 1.0;
  return a;
});

export const AGENT_IDS = instances.map((a) => a.id);

export function listAgents() {
  return instances.map((a) => ({
    agentId: a.id,
    name: a.name,
    cluster: a.cluster,
    description: a.description,
    baseWeight: a.weight,
    defaultActive: true,
  }));
}

export function getAgents(activeIds) {
  if (!activeIds || !activeIds.length) return [];
  const set = new Set(activeIds);
  return instances.filter((a) => set.has(a.id));
}

export function getAgent(id) {
  return instances.find((a) => a.id === id) || null;
}
