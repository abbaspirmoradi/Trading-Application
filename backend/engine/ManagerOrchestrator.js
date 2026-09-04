// The Manager / Meta-Orchestrator.
//
//   [1] Quorum validation      — are enough agents active to decide anything?
//   [2] Confidence matrix      — weighted consensus across active agents
//   [3] Veto check engine      — hard rules that cannot be outvoted
//   [4] Meta-label sizing      — P(profit) from the secondary model -> Kelly
//   [5] Execution contract     — action, size, entry, stop, targets, rationale
//
// Only user-selected agents run. Everything the pipeline concludes is traceable
// back to a specific agent output, which is why each stage records its own
// diagnostic block in the returned decision.

import { getAgents } from '../agents/index.js';
import { QUORUM, ACTIONS, RISK, CLUSTERS } from '../config/constants.js';
import { evaluateVetoes, VETO_SEVERITY } from './VetoEngine.js';
import { computeExecutionBarriers, resolveEntry } from './BarrierEngine.js';
import { computeKellySize } from './KellyEngine.js';
import { metaLabel } from './MetaLabeler.js';
import { clamp } from '../lib/stats.js';
import { publish } from '../bus/eventBus.js';

const DIRECTION_THRESHOLD = 12; // composite score needed to commit to a side

export async function runAnalysis({
  ticker,
  activeAgentIds,
  marketContext,
  portfolio,
  performanceWeights = {},
  timeframe = '1D',
}) {
  const startedAt = Date.now();
  const ctx = { ...marketContext, portfolio, timeframe };
  const agents = getAgents(activeAgentIds);

  /* ---------------- Stage 1: quorum validation ---------------- */
  const quorum = validateQuorum(agents);
  if (!quorum.passed) {
    return {
      ticker,
      asOf: ctx.asOf,
      finalAction: ACTIONS.HOLD,
      compositeScore: 0,
      confidence: 0,
      quorum,
      blocked: true,
      blockReason: quorum.message,
      activeAgentCount: agents.length,
      agentBreakdown: [],
      vetoesTriggered: [],
      executiveSummary: [quorum.message],
      elapsedMs: Date.now() - startedAt,
    };
  }

  /* ---------------- Run the selected agents concurrently ---------------- */
  await publish('analysis.requested', { ticker, agents: agents.map((a) => a.id), timeframe });
  const agentBreakdown = await Promise.all(agents.map((a) => a.run(ctx)));
  await publish('analysis.agents.completed', {
    ticker,
    results: agentBreakdown.map((r) => ({ agentId: r.agentId, score: r.score, signal: r.signal })),
  });

  const usable = agentBreakdown.filter((r) => r.status === 'COMPLETE');

  /* ---------------- Stage 2: weighted confidence matrix ---------------- */
  const consensus = buildConsensus(usable, performanceWeights);

  let direction = consensus.composite > DIRECTION_THRESHOLD ? 1
    : consensus.composite < -DIRECTION_THRESHOLD ? -1 : 0;

  /* ---------------- Stage 3: veto engine ---------------- */
  // Settle the entry before the barriers so the stop, target and reward:risk
  // all describe the trade that would actually be placed.
  const entry = resolveEntry(ctx, direction || 1, agentBreakdown);
  const barriers = computeExecutionBarriers(ctx, direction || 1, agentBreakdown, entry.entryPrice);
  // For a level that is out of reach today, show what the trade *would* look
  // like if it triggers — clearly labelled as projected, never as a live order.
  const projectedBarriers = entry.mode === 'WATCH'
    ? computeExecutionBarriers(ctx, direction || 1, agentBreakdown, entry.triggerLevel)
    : null;
  const vetoResult = evaluateVetoes(usable, direction, barriers);

  /* ---------------- Stage 4: meta-labelling and sizing ---------------- */
  const meta = direction !== 0 ? metaLabel(ctx, direction) : null;

  // Blend the meta-model's probability with the consensus prior in log-odds
  // space. The consensus expresses conviction; the meta-model expresses
  // historically-calibrated odds. Neither alone should size the trade.
  const consensusPrior = clamp(0.5 + (Math.abs(consensus.composite) / 100) * 0.22 * consensus.avgConfidence * 2, 0.3, 0.78);
  const blendedProbability = meta
    ? clamp(sigmoidBlend(meta.probability, consensusPrior, 0.55), 0.05, 0.95)
    : 0.5;

  const payoffRatio = barriers?.riskRewardRatio ?? 1;
  const riskAgent = usable.find((r) => r.agentId === 'Portfolio_Risk_Agent');
  const equity = riskAgent?.payload.equity ?? portfolio?.equity ?? 100000;
  const maxRiskDollar = riskAgent?.payload.maxRiskDollar ?? equity * (RISK.maxRiskPerTradePct / 100);
  const maxPositionDollar = riskAgent?.payload.maxPositionDollar ?? equity * (RISK.hardMaxPositionPct / 100);
  const remainingHeatPct = riskAgent
    ? Math.max(0, RISK.maxPortfolioHeatPct - riskAgent.payload.portfolioHeatPct)
    : RISK.maxPortfolioHeatPct;

  const sizing = computeKellySize({
    winProbability: blendedProbability,
    payoffRatio,
    equity,
    price: ctx.price,
    riskPerShare: barriers?.riskPerShare ?? ctx.price * 0.05,
    maxRiskDollar,
    maxPositionDollar,
    remainingHeatPct,
  });

  // Vetoes scale the final size; a BLOCK zeroes it.
  const vetoAdjustedShares = Math.floor(sizing.suggestedShares * vetoResult.sizeMultiplier);
  const finalSizing = {
    ...sizing,
    sizeMultiplierFromVetoes: Number(vetoResult.sizeMultiplier.toFixed(3)),
    suggestedShares: vetoAdjustedShares,
    allocationDollar: Number((vetoAdjustedShares * ctx.price).toFixed(2)),
    portfolioPercent: Number(((vetoAdjustedShares * ctx.price / equity) * 100).toFixed(2)),
    actualRiskDollar: Number((vetoAdjustedShares * (barriers?.riskPerShare ?? 0)).toFixed(2)),
    actualRiskPercent: Number(((vetoAdjustedShares * (barriers?.riskPerShare ?? 0) / equity) * 100).toFixed(3)),
  };

  /* ---------------- Stage 5: execution contract ---------------- */
  const finalAction = decideAction({
    direction,
    composite: consensus.composite,
    probability: blendedProbability,
    blocked: vetoResult.blocked,
    shares: finalSizing.suggestedShares,
    hasPosition: (portfolio?.positions || []).some((p) => p.ticker === ticker),
    // A trigger out of reach is not actionable today, however good the setup is.
    awaitingTrigger: entry.mode === 'WATCH',
  });

  // A HOLD carries no order, so it must not display a share count — the sizing
  // block is retained under `sizingIfTaken` so the UI can still show what the
  // trade would have looked like had it cleared.
  const reportedSizing = finalAction === ACTIONS.HOLD
    ? {
      ...finalSizing,
      suggestedShares: 0,
      allocationDollar: 0,
      portfolioPercent: 0,
      actualRiskDollar: 0,
      actualRiskPercent: 0,
      bindingConstraint: 'no position — decision is HOLD',
      sizingIfTaken: { shares: finalSizing.suggestedShares, allocationDollar: finalSizing.allocationDollar },
    }
    : finalSizing;

  const executionPlan = buildExecutionPlan({
    ctx, direction, barriers, projectedBarriers, entry, action: finalAction,
  });

  const decision = {
    ticker,
    asOf: ctx.asOf,
    timeframe,
    price: ctx.price,
    finalAction,
    direction,
    compositeScore: consensus.composite,
    confidence: Number((consensus.avgConfidence * (vetoResult.blocked ? 0.5 : 1)).toFixed(3)),
    probabilityOfProfit: Number(blendedProbability.toFixed(4)),
    quorum,
    consensus,
    metaLabel: meta,
    positionSizing: reportedSizing,
    executionPlan,
    barriers,
    vetoesTriggered: vetoResult.vetoes,
    blocked: vetoResult.blocked,
    activeAgentCount: agents.length,
    completedAgentCount: usable.length,
    agentBreakdown,
    executiveSummary: buildExecutiveSummary({
      ticker, finalAction, consensus, vetoResult, meta, blendedProbability,
      finalSizing: reportedSizing, barriers, usable, direction, price: ctx.price,
    }),
    dataProvider: ctx.provider,
    dataSources: ctx.dataSources,
    elapsedMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString(),
  };

  await publish('analysis.decision', {
    ticker, finalAction, compositeScore: decision.compositeScore, vetoes: vetoResult.vetoes.map((v) => v.code),
  });

  return decision;
}

/* ------------------------------------------------------------------ */

function validateQuorum(agents) {
  const clusters = [...new Set(agents.map((a) => a.cluster))];
  if (agents.length === 0) {
    return { passed: false, activeAgents: 0, clusters, message: 'No agents are active. Select at least one agent to run an analysis.' };
  }
  if (agents.length < QUORUM.minActiveAgents) {
    return {
      passed: false,
      activeAgents: agents.length,
      clusters,
      message: `Quorum not met: ${agents.length} of the minimum ${QUORUM.minActiveAgents} agents are active. Enable more agents for a decision.`,
    };
  }
  const missing = QUORUM.requiredClustersForHighConviction.filter((c) => !clusters.includes(c));
  return {
    passed: true,
    activeAgents: agents.length,
    clusters,
    highConviction: missing.length === 0,
    missingClusters: missing,
    message: missing.length
      ? `Quorum met, but conviction is capped: no active agent from the ${missing.join(', ')} cluster${missing.length > 1 ? 's' : ''}.`
      : 'Quorum met across all required clusters.',
  };
}

/**
 * Confidence matrix. Every agent contributes score/100 in [-1, 1], weighted by
 * (base weight) x (its own confidence) x (its rolling performance weight).
 */
function buildConsensus(results, performanceWeights) {
  if (!results.length) return { composite: 0, avgConfidence: 0, contributions: [], agreement: 0, dispersion: 0 };

  // Gatekeeper clusters do not get a directional vote. The risk agent scoring
  // +100 means "this trade breaches no limit" — that is permission, not a
  // reason to be long, and letting it vote would inflate the composite of every
  // idea analysed against an empty portfolio. Likewise the barrier agent scores
  // reward:risk quality, and infers its side from the same 30-week MA that
  // Weinstein already votes on. Both still appear in the breakdown, still veto,
  // and still drive sizing.
  const NON_DIRECTIONAL = new Set([CLUSTERS.RISK, CLUSTERS.EXECUTION]);

  const contributions = results.map((r) => {
    const base = BASE_WEIGHT[r.agentId] ?? 1;
    const perf = performanceWeights[r.agentId] ?? 1;
    const votes = !NON_DIRECTIONAL.has(r.cluster);
    const weight = votes ? base * r.confidence * perf : 0;
    return {
      agentId: r.agentId,
      agentName: r.agentName,
      cluster: r.cluster,
      directionalVote: votes,
      normalizedScore: Number((r.score / 100).toFixed(3)),
      baseWeight: base,
      performanceWeight: Number(perf.toFixed(3)),
      effectiveWeight: Number(weight.toFixed(3)),
      weightedContribution: Number(((r.score / 100) * weight).toFixed(3)),
      role: votes ? 'VOTER' : 'GATEKEEPER',
    };
  });

  const totalWeight = contributions.reduce((a, c) => a + c.effectiveWeight, 0) || 1;
  const composite = Number(((contributions.reduce((a, c) => a + c.weightedContribution, 0) / totalWeight) * 100).toFixed(1));

  // Agreement: share of voting agents on the same side as the composite. A
  // composite of +40 built from unanimity is a very different object from one
  // built from +90/-60 disagreement, and the confidence must reflect that.
  const voters = results.filter((r) => !NON_DIRECTIONAL.has(r.cluster));
  const directional = voters.filter((r) => Math.abs(r.score) > 10);
  const agreeing = directional.filter((r) => Math.sign(r.score) === Math.sign(composite)).length;
  const agreement = directional.length ? agreeing / directional.length : 0;

  const scores = voters.map((r) => r.score);
  const dispersion = scores.length
    ? Math.sqrt(scores.reduce((a, s) => a + (s - composite) ** 2, 0) / scores.length)
    : 0;

  const rawConfidence = voters.length
    ? voters.reduce((a, r) => a + r.confidence, 0) / voters.length
    : 0;
  const avgConfidence = clamp(rawConfidence * (0.55 + 0.45 * agreement), 0, 1);

  // Cluster-level view for the UI radar chart.
  const clusterScores = {};
  for (const c of Object.values(CLUSTERS)) {
    const inCluster = results.filter((r) => r.cluster === c);
    if (inCluster.length) clusterScores[c] = Number((inCluster.reduce((a, r) => a + r.score, 0) / inCluster.length).toFixed(1));
  }

  return {
    composite,
    avgConfidence: Number(avgConfidence.toFixed(3)),
    rawConfidence: Number(rawConfidence.toFixed(3)),
    agreement: Number(agreement.toFixed(3)),
    dispersion: Number(dispersion.toFixed(1)),
    totalWeight: Number(totalWeight.toFixed(2)),
    contributions,
    clusterScores,
    votingAgentCount: voters.length,
    gatekeeperCount: results.length - voters.length,
    bullishCount: voters.filter((r) => r.signal === 'BULLISH').length,
    bearishCount: voters.filter((r) => r.signal === 'BEARISH').length,
    neutralCount: voters.filter((r) => r.signal === 'NEUTRAL').length,
  };
}

const BASE_WEIGHT = {
  CAN_SLIM_Agent: 1.0,
  Weinstein_Stage_Agent: 1.4,
  Chart_Pattern_Agent: 1.1,
  Volume_OrderFlow_Agent: 1.2,
  Relative_Strength_Agent: 1.3,
  Fractional_Quant_Agent: 0.9,
  Intermarket_Macro_Agent: 1.0,
  Geopolitical_News_Agent: 0.7,
  Options_Sentiment_Agent: 0.8,
  Portfolio_Risk_Agent: 1.0,
  Triple_Barrier_Exit_Agent: 0.6,
};

/** Blend two probabilities in log-odds space; `w` weights the first. */
function sigmoidBlend(p1, p2, w) {
  const l1 = Math.log(p1 / (1 - p1));
  const l2 = Math.log(p2 / (1 - p2));
  const l = w * l1 + (1 - w) * l2;
  return 1 / (1 + Math.exp(-l));
}

function decideAction({ direction, composite, probability, blocked, shares, hasPosition, awaitingTrigger }) {
  if (blocked) return hasPosition ? ACTIONS.REDUCE : ACTIONS.HOLD;
  if (awaitingTrigger && direction > 0) return ACTIONS.HOLD;
  if (shares <= 0) return ACTIONS.HOLD;

  if (direction > 0) {
    if (composite >= 55 && probability >= 0.60) return ACTIONS.STRONG_BUY;
    if (composite >= DIRECTION_THRESHOLD && probability >= 0.50) return ACTIONS.BUY;
    return ACTIONS.HOLD;
  }
  if (direction < 0) {
    if (hasPosition) return composite <= -45 ? ACTIONS.SELL : ACTIONS.REDUCE;
    return composite <= -45 && probability >= 0.55 ? ACTIONS.SHORT : ACTIONS.HOLD;
  }
  return ACTIONS.HOLD;
}

/**
 * Turns the decision into an actual order. Longs enter on a stop-limit above
 * the pattern's breakout level (buy strength, never a falling knife); if price
 * is already through the trigger, it becomes a limit order at the market.
 */
function buildExecutionPlan({ ctx, direction, barriers, projectedBarriers, entry, action }) {
  const price = ctx.price;

  if (entry.mode === 'WATCH' && direction > 0) {
    return {
      orderType: 'WATCH',
      note: `The ${entry.pattern?.pattern ?? 'pattern'} trigger sits at ${entry.triggerLevel.toFixed(2)} — ${entry.distancePct.toFixed(1)}% above spot. That is too far to place an order against today.`,
      watchTrigger: Number(entry.triggerLevel.toFixed(2)),
      distanceToTriggerPct: Number(entry.distancePct.toFixed(1)),
      // No live order exists, so there are no live levels. These are what the
      // trade would look like if and when the trigger is reached.
      stopLoss: null,
      profitTarget: null,
      projected: projectedBarriers ? {
        ifTriggeredAt: Number(entry.triggerLevel.toFixed(2)),
        stopLoss: projectedBarriers.stopLoss,
        profitTarget: projectedBarriers.profitTarget,
        riskRewardRatio: projectedBarriers.riskRewardRatio,
      } : null,
      entryNote: 'Set a price alert at the trigger and re-run the analysis if it gets there. Chasing a level this far away is how a good pattern becomes a bad entry.',
    };
  }

  if (!barriers || direction === 0 || action === ACTIONS.HOLD) {
    return {
      orderType: 'NONE',
      note: 'No order is generated for a HOLD decision. Monitor the levels below for a change of state.',
      watchTrigger: entry.triggerLevel ?? null,
      stopLoss: barriers?.stopLoss ?? null,
      profitTarget: barriers?.profitTarget ?? null,
    };
  }

  const isLong = direction > 0;
  const useStop = entry.mode === 'STOP_LIMIT';
  const triggerPrice = entry.entryPrice;
  // Slippage allowance scales with the trade's own risk, floored at 20bp.
  const offset = Math.max(price * 0.002, (barriers.riskPerShare ?? price * 0.02) * 0.12);
  const limitPrice = isLong ? triggerPrice + offset : triggerPrice - offset;

  return {
    orderType: useStop ? (isLong ? 'BUY_STOP_LIMIT_GTC' : 'SELL_STOP_LIMIT_GTC') : (isLong ? 'BUY_LIMIT_DAY' : 'SELL_LIMIT_DAY'),
    side: isLong ? 'BUY' : 'SELL_SHORT',
    triggerPrice: Number(triggerPrice.toFixed(2)),
    limitPrice: Number(limitPrice.toFixed(2)),
    distanceToTriggerPct: Number(entry.distancePct.toFixed(2)),
    maxSlippageBps: Math.round((offset / price) * 10000),
    stopLoss: barriers.stopLoss,
    stopBasis: barriers.stopBasis,
    profitTarget1: barriers.profitTarget1,
    profitTarget: barriers.profitTarget,
    timeBarrier: barriers.timeBarrier,
    riskRewardRatio: barriers.riskRewardRatio,
    entryNote: useStop
      ? `Resting stop-limit above the ${entry.pattern?.pattern ?? 'breakout'} trigger at ${triggerPrice.toFixed(2)} (${entry.distancePct.toFixed(1)}% above spot) — no fill unless the breakout actually happens. Stop and targets are measured from the trigger, not from spot.`
      : 'Price is already through the trigger; enter on a limit at or better than the current quote and do not chase.',
  };
}

function buildExecutiveSummary({ ticker, finalAction, consensus, vetoResult, meta, blendedProbability, finalSizing, barriers, usable, direction, price }) {
  const lines = [];
  const verb = { STRONG_BUY: 'Strong buy', BUY: 'Buy', HOLD: 'Hold / no action', REDUCE: 'Reduce exposure', SELL: 'Sell', SHORT: 'Short' }[finalAction];

  lines.push(`${verb} ${ticker} at ${price.toFixed(2)} — composite ${consensus.composite > 0 ? '+' : ''}${consensus.composite} across ${usable.length} agents with ${(consensus.agreement * 100).toFixed(0)}% directional agreement.`);

  const top = [...usable]
    .filter((r) => r.cluster !== CLUSTERS.RISK && r.cluster !== CLUSTERS.EXECUTION)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 3);
  for (const t of top) {
    lines.push(`${t.agentName}: ${t.score > 0 ? '+' : ''}${t.score} — ${t.reasoning[0]}`);
  }

  if (vetoResult.blocked) {
    const block = vetoResult.vetoes.find((v) => v.severity === VETO_SEVERITY.BLOCK);
    lines.push(`BLOCKED by ${block.code}: ${block.message}`);
  } else if (vetoResult.vetoes.length) {
    lines.push(`Size reduced to ${(vetoResult.sizeMultiplier * 100).toFixed(0)}% by ${vetoResult.vetoes.length} downgrade veto${vetoResult.vetoes.length > 1 ? 'es' : ''}: ${vetoResult.vetoes.map((v) => v.code).join(', ')}.`);
  } else {
    lines.push('No vetoes triggered — every hard risk rule passed.');
  }

  if (meta && direction !== 0) {
    const basis = meta.method === 'LOGISTIC_TRIPLE_BARRIER'
      ? `fitted on ${meta.trainingSamples} triple-barrier labels, base rate ${(meta.baseRate * 100).toFixed(0)}%`
      : meta.note;
    lines.push(`Meta-model puts P(target before stop) at ${(blendedProbability * 100).toFixed(1)}% (${basis}).`);
  }

  if (finalSizing.suggestedShares > 0 && barriers) {
    lines.push(`Size ${finalSizing.suggestedShares} shares (${finalSizing.portfolioPercent}% of equity, $${finalSizing.actualRiskDollar.toLocaleString('en-US')} at risk = ${finalSizing.actualRiskPercent}%), bound by the ${finalSizing.bindingConstraint}.`);
    lines.push(`Stop ${barriers.stopLoss} (${barriers.stopBasis}), first target ${barriers.profitTarget1}, full target ${barriers.profitTarget}, time barrier ${barriers.timeBarrier} — ${barriers.riskRewardRatio}:1 reward to risk.`);
  } else if (!vetoResult.blocked) {
    lines.push('Position size resolves to zero at these odds — the edge does not clear the risk limits. No trade.');
  }

  return lines;
}
