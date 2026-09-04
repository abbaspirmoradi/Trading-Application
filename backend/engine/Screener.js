// Daily screener.
//
// Runs the full agent pipeline across the universe and ranks what survives.
// The ranking is deliberately conservative: a name only qualifies as a BUY
// candidate if it clears every hard veto. High conviction with a blocking veto
// is not a "strong buy with a caveat" — it is not a buy.
//
// Results are cached, because a daily screen should behave like one: the same
// answer all session unless explicitly refreshed.

import { runAnalysis } from './ManagerOrchestrator.js';
import { buildMarketContext } from '../data/marketDataService.js';
import { mapLimit } from '../lib/concurrency.js';
import { SCREENER_UNIVERSE } from '../config/constants.js';
import { AGENT_IDS } from '../agents/index.js';
import { clamp } from '../lib/stats.js';

const CACHE_TTL_MS = 15 * 60_000;
const cache = new Map();

/**
 * Composite ranking. Every term is disclosed on the result so a pick can be
 * argued with rather than merely trusted.
 */
function scoreCandidate(d) {
  const stage = d.agentBreakdown.find((a) => a.agentId === 'Weinstein_Stage_Agent')?.payload ?? {};
  const rs = d.agentBreakdown.find((a) => a.agentId === 'Relative_Strength_Agent')?.payload ?? {};
  const vol = d.agentBreakdown.find((a) => a.agentId === 'Volume_OrderFlow_Agent')?.payload ?? {};
  const pattern = d.agentBreakdown.find((a) => a.agentId === 'Chart_Pattern_Agent')?.payload ?? {};

  const components = {
    // Weight of evidence from the agent panel.
    consensus: clamp(d.compositeScore, 0, 100) * 0.30,
    // Historically-calibrated odds from the meta-model.
    probability: clamp((d.probabilityOfProfit - 0.5) * 200, 0, 100) * 0.25,
    // Leadership: the most persistent edge in this framework.
    leadership: clamp(rs.rsRating ?? 50, 0, 100) * 0.15,
    // Stage 2 is the only stage worth buying; a fresh breakout is best of all.
    stage: (stage.stage === 2 ? (stage.freshBreakout ? 100 : 70) : stage.stage === 1 ? 30 : 0) * 0.15,
    // Institutional participation behind the move.
    volume: clamp((vol.volumeRatio ?? 1) * 40, 0, 100) * 0.08,
    // Asymmetry of the actual trade on offer.
    rewardRisk: clamp(((d.barriers?.riskRewardRatio ?? 0) / 4) * 100, 0, 100) * 0.07,
  };

  const total = Object.values(components).reduce((a, b) => a + b, 0);
  return {
    total: Number(total.toFixed(1)),
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Number(v.toFixed(1))])),
    patternName: pattern.pattern ?? null,
  };
}

export async function screenUniverse({
  universe = SCREENER_UNIVERSE,
  activeAgentIds = AGENT_IDS,
  portfolio,
  performanceWeights = {},
  limit = 10,
  concurrency = 4,
  force = false,
} = {}) {
  const key = `screen:${universe.length}:${activeAgentIds.length}:${new Date().toISOString().slice(0, 10)}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.value, cached: true, cacheAgeSeconds: Math.round((Date.now() - hit.at) / 1000) };
  }

  const startedAt = Date.now();

  const rows = await mapLimit(universe, concurrency, async (ticker) => {
    const ctx = await buildMarketContext(ticker);
    const d = await runAnalysis({ ticker, activeAgentIds, marketContext: ctx, portfolio, performanceWeights });
    const stageP = d.agentBreakdown.find((a) => a.agentId === 'Weinstein_Stage_Agent')?.payload ?? {};
    const rsP = d.agentBreakdown.find((a) => a.agentId === 'Relative_Strength_Agent')?.payload ?? {};
    const rank = scoreCandidate(d);

    return {
      ticker,
      price: d.price,
      finalAction: d.finalAction,
      compositeScore: d.compositeScore,
      confidence: d.confidence,
      probabilityOfProfit: d.probabilityOfProfit,
      stage: stageP.stage ?? null,
      stageName: stageP.stageName ?? null,
      freshBreakout: Boolean(stageP.freshBreakout),
      rsRating: rsP.rsRating ?? null,
      pattern: rank.patternName,
      blocked: d.blocked,
      vetoes: d.vetoesTriggered.map((v) => ({ code: v.code, severity: v.severity })),
      entryTrigger: d.executionPlan?.triggerPrice ?? null,
      stopLoss: d.executionPlan?.stopLoss ?? d.barriers?.stopLoss ?? null,
      profitTarget: d.executionPlan?.profitTarget ?? d.barriers?.profitTarget ?? null,
      riskRewardRatio: d.barriers?.riskRewardRatio ?? null,
      suggestedShares: d.positionSizing?.suggestedShares ?? 0,
      allocationDollar: d.positionSizing?.allocationDollar ?? 0,
      rankScore: rank.total,
      rankComponents: rank.components,
      rationale: d.executiveSummary?.slice(1, 4) ?? [],
      dataSources: d.dataSources,
    };
  });

  const analysed = rows.filter((r) => r && !r.error);
  const errors = rows.filter((r) => r && r.error).map((r) => ({ ticker: r.item, error: r.error }));

  // A candidate must clear every hard veto — no exceptions for conviction.
  const buys = analysed
    .filter((r) => !r.blocked && ['BUY', 'STRONG_BUY'].includes(r.finalAction) && r.suggestedShares > 0)
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, limit);

  // Names that pass on merit but are held back by a specific rule — worth
  // watching, because the rule may clear.
  const watchlist = analysed
    .filter((r) => !buys.includes(r) && r.compositeScore > 20 && r.stage !== 4)
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 8)
    .map((r) => ({
      ...r,
      heldBackBy: r.blocked
        ? r.vetoes.find((v) => v.severity === 'BLOCK')?.code ?? 'VETO'
        : r.finalAction === 'HOLD' ? 'Conviction or odds below the entry threshold' : r.finalAction,
    }));

  const avoid = analysed
    .filter((r) => r.stage === 4 || r.compositeScore < -35)
    .sort((a, b) => a.compositeScore - b.compositeScore)
    .slice(0, 8);

  const stageCounts = [1, 2, 3, 4].reduce((acc, st) => {
    acc[`stage${st}`] = analysed.filter((r) => r.stage === st).length;
    return acc;
  }, {});

  // Breadth of the universe itself is a market-health read in its own right.
  const bullishShare = analysed.length ? (stageCounts.stage2 / analysed.length) * 100 : 0;
  const marketTone = bullishShare > 55 ? 'BROAD_ADVANCE'
    : bullishShare > 35 ? 'MIXED'
      : bullishShare > 20 ? 'NARROW' : 'DEFENSIVE';

  const value = {
    generatedAt: new Date().toISOString(),
    universeSize: universe.length,
    analysed: analysed.length,
    elapsedMs: Date.now() - startedAt,
    marketBreadth: {
      ...stageCounts,
      stage2SharePct: Number(bullishShare.toFixed(1)),
      tone: marketTone,
      interpretation: {
        BROAD_ADVANCE: 'Most of the universe is in a Stage 2 advance. Trend-following entries have the best odds in this environment.',
        MIXED: 'Participation is split. Be selective and demand leadership — an average setup is not good enough here.',
        NARROW: 'Few names are advancing. Leadership is thin, which historically precedes broader weakness.',
        DEFENSIVE: 'Very little is working. The highest-expectancy action in this tape is usually to hold cash.',
      }[marketTone],
    },
    picks: buys,
    watchlist,
    avoid,
    errors,
    cached: false,
  };

  cache.set(key, { at: Date.now(), value });
  return value;
}
