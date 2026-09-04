// Declarative description of the Manager Agent's decision process.
//
// This mirrors the BPMN definition in `manager-decision.bpmn` one-to-one. The
// pipeline itself is executed in-process by ManagerOrchestrator (see the note
// in the README on why a BPMN engine is optional here); this module keeps a
// machine-readable description of the stages so the UI can render the pipeline
// and an external engine can be wired to the same contract.

export const STAGES = [
  {
    id: 'quorum_validation',
    name: 'Quorum Validation',
    type: 'businessRuleTask',
    description: 'Verify the minimum number of active agents and record which clusters are represented.',
    outputs: ['passed', 'activeAgents', 'missingClusters'],
  },
  {
    id: 'agent_fanout',
    name: 'Parallel Agent Execution',
    type: 'parallelGateway',
    description: 'Dispatch the analysis payload to every user-selected agent concurrently; each agent is isolated so one failure cannot abort the run.',
    outputs: ['agentBreakdown'],
  },
  {
    id: 'confidence_matrix',
    name: 'Weighted Confidence Matrix',
    type: 'serviceTask',
    description: 'Normalise agent scores to [-1,1], weight by base weight x confidence x rolling performance, and compute the composite plus directional agreement. Gatekeeper clusters are excluded from the vote.',
    outputs: ['compositeScore', 'agreement', 'clusterScores'],
  },
  {
    id: 'veto_engine',
    name: 'Hard Veto Check',
    type: 'businessRuleTask',
    description: 'Apply rules that cannot be outvoted: Stage 4, correlation over-concentration, portfolio heat, unconfirmed breakout volume, threat radar, reward:risk floor.',
    outputs: ['vetoes', 'blocked', 'sizeMultiplier'],
  },
  {
    id: 'meta_labeling',
    name: 'Meta-Label Sizing',
    type: 'serviceTask',
    description: 'Secondary classifier fitted on triple-barrier labels predicts P(profit target before stop); blended with the consensus prior in log-odds space.',
    outputs: ['probabilityOfProfit', 'featureImportance'],
  },
  {
    id: 'kelly_sizing',
    name: 'Fractional Kelly Sizing',
    type: 'serviceTask',
    description: 'f* = (p(b+1)-1)/b scaled by the Kelly fraction, then capped by the per-trade risk limit, the 5% position ceiling and the remaining heat budget.',
    outputs: ['suggestedShares', 'bindingConstraint'],
  },
  {
    id: 'execution_contract',
    name: 'Execution Contract Synthesis',
    type: 'serviceTask',
    description: 'Emit the order: type, trigger, limit, stop, targets, time barrier and the rationale from every contributing agent.',
    outputs: ['finalAction', 'executionPlan', 'executiveSummary'],
  },
];

export function describePipeline() {
  return {
    processId: 'manager_decision_process',
    name: 'Manager Agent Decision Pipeline',
    stageCount: STAGES.length,
    stages: STAGES,
    bpmnFile: 'workflow/manager-decision.bpmn',
  };
}
