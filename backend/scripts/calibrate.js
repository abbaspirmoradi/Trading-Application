// Calibration: measures the system against itself and writes the results to
// config/calibration.json, which the orchestrator reads to attach caveats to
// every decision. Re-run whenever agents, thresholds or the universe change:
//
//   npm run calibrate
//
// Everything here is cross-sectional — it cannot be computed from one
// decision, only from the population of them. That is why it lives in a file
// with a timestamp rather than being recomputed per request.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAnalysis } from '../engine/ManagerOrchestrator.js';
import { pooledBacktest, EXIT_POLICIES } from '../engine/PooledBacktest.js';
import { buildMarketContext, getFullHistory } from '../data/marketDataService.js';
import { AGENT_IDS } from '../agents/index.js';
import { correlation, mean, stdev } from '../lib/stats.js';
import { closes, sma, atr } from '../lib/indicators.js';
import { SCREENER_UNIVERSE, BARRIERS, CLUSTERS } from '../config/constants.js';
import { mapLimit } from '../lib/concurrency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../config/calibration.json');

const VOTERS = AGENT_IDS.filter((id) => !['Portfolio_Risk_Agent', 'Triple_Barrier_Exit_Agent'].includes(id));
const portfolio = { equity: 250000, cash: 250000, positions: [] };

console.log(`[calibrate] horizon ${BARRIERS.horizon}, universe ${SCREENER_UNIVERSE.length} names\n`);

/* ---------------- 1. Agent redundancy ---------------- */
console.log('[calibrate] 1/4 running every agent across the universe…');
const decisions = (await mapLimit(SCREENER_UNIVERSE, 5, async (t) => {
  const ctx = await buildMarketContext(t);
  return runAnalysis({ ticker: t, activeAgentIds: AGENT_IDS, marketContext: ctx, portfolio });
})).filter((d) => d && !d.error);

const scoreOf = (d, id) => d.agentBreakdown.find((a) => a.agentId === id)?.score ?? 0;
const series = Object.fromEntries(VOTERS.map((id) => [id, decisions.map((d) => scoreOf(d, id))]));

const correlationMatrix = {};
for (const a of VOTERS) {
  correlationMatrix[a] = {};
  for (const b of VOTERS) correlationMatrix[a][b] = a === b ? 1 : Number(correlation(series[a], series[b]).toFixed(3));
}

/**
 * Effective number of independent opinions among a set of agents:
 *   N_eff = N² / Σ|r_ij|   (= N when uncorrelated, 1 when identical)
 */
function effectiveOpinions(ids) {
  const n = ids.length;
  if (!n) return 0;
  let total = 0;
  for (const a of ids) for (const b of ids) total += Math.abs(correlationMatrix[a]?.[b] ?? (a === b ? 1 : 0));
  return (n * n) / total;
}

const pairs = [];
for (let i = 0; i < VOTERS.length; i++) for (let j = i + 1; j < VOTERS.length; j++) {
  pairs.push({ a: VOTERS[i], b: VOTERS[j], r: correlationMatrix[VOTERS[i]][VOTERS[j]] });
}
pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
console.log(`   ${VOTERS.length} voting agents behave like ${effectiveOpinions(VOTERS).toFixed(1)} independent opinions`);

/* ---------------- 2. Pattern detection rates ---------------- */
console.log('[calibrate] 2/4 pattern detection rates…');
const patternCounts = {};
for (const d of decisions) {
  const p = d.agentBreakdown.find((a) => a.agentId === 'Chart_Pattern_Agent')?.payload?.pattern ?? 'none';
  patternCounts[p] = (patternCounts[p] || 0) + 1;
}
const patternRates = Object.fromEntries(
  Object.entries(patternCounts).map(([k, v]) => [k, Number((v / decisions.length).toFixed(3))]),
);
for (const [k, v] of Object.entries(patternRates)) console.log(`   ${k.padEnd(26)} ${(v * 100).toFixed(0)}%`);

/* ---------------- 3. Strategy vs buy-and-hold ---------------- */
console.log('[calibrate] 3/4 pooled backtest…');
const bt = await pooledBacktest({ universe: SCREENER_UNIVERSE, exitPolicy: EXIT_POLICIES.FIXED_BARRIER });

/* ---------------- 4. Drawdown comparison ---------------- */
console.log('[calibrate] 4/4 drawdown curves…');
function curveStats(rets) {
  let eq = 1, peak = 1, maxDD = 0;
  for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak); }
  const years = rets.length / 252;
  const cagr = years > 0 ? (Math.pow(eq, 1 / years) - 1) * 100 : 0;
  return { cagrPct: cagr, maxDDPct: maxDD * 100, volPct: stdev(rets) * Math.sqrt(252) * 100 };
}
const curves = (await mapLimit(SCREENER_UNIVERSE, 5, async (ticker) => {
  const bars = await getFullHistory(ticker);
  if (bars.length < 600) return null;
  const px = closes(bars);
  const maSlow = sma(px, 200), maFast = sma(px, 50), a = atr(bars, BARRIERS.atrPeriod);
  const strat = [], bh = [];
  let inPos = false, stop = 0;
  for (let i = 260; i < bars.length; i++) {
    const r = px[i] / px[i - 1] - 1;
    bh.push(r);
    if (inPos) {
      if (bars[i].low <= stop) { inPos = false; strat.push(stop / px[i - 1] - 1); continue; }
      strat.push(r);
      if (px[i] >= stop + (BARRIERS.profitAtrMultiple + BARRIERS.stopAtrMultiple) * (a[i] || 0)) inPos = false;
    } else {
      strat.push(0);
      if (maSlow[i] != null && maFast[i] != null && px[i] > maSlow[i] && maFast[i] > maSlow[i] && a[i]) {
        inPos = true; stop = px[i] - BARRIERS.stopAtrMultiple * a[i];
      }
    }
  }
  return { strat: curveStats(strat), bh: curveStats(bh) };
})).filter(Boolean);
const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return Number(s[Math.floor(s.length / 2)].toFixed(2)); };

const calibration = {
  generatedAt: new Date().toISOString(),
  horizon: BARRIERS.horizon,
  universeSize: SCREENER_UNIVERSE.length,
  decisionsSampled: decisions.length,

  agentRedundancy: {
    votingAgents: VOTERS,
    correlationMatrix,
    effectiveOpinionsAllVoters: Number(effectiveOpinions(VOTERS).toFixed(2)),
    mostRedundantPairs: pairs.slice(0, 5).map((p) => ({ a: p.a, b: p.b, r: p.r })),
  },

  patternDetectionRates: patternRates,

  strategyValidation: {
    method: 'Pooled cross-sectional backtest, fixed triple barrier, buy-and-hold benchmark, bootstrap by ticker',
    period: bt.period,
    trades: bt.pooled.trades,
    winRatePct: bt.pooled.winRatePct,
    meanExcessPerTradePct: bt.pooled.meanExcessVsBuyHoldPct,
    bootstrapCi95: bt.bootstrap ? [bt.bootstrap.ci95Low, bt.bootstrap.ci95High] : null,
    perTradeEdgeSignificant: Boolean(bt.bootstrap?.excludesZero),
    tickersBeatingBuyAndHold: bt.versusBuyAndHold.tickersWhereStrategyWon,
    tickersCompared: bt.versusBuyAndHold.tickersCompared,
    medianStrategyTotalPct: bt.versusBuyAndHold.medianStrategyPct,
    medianBuyHoldTotalPct: bt.versusBuyAndHold.medianBuyHoldPct,
    medianCagr: { strategy: med(curves.map((c) => c.strat.cagrPct)), buyHold: med(curves.map((c) => c.bh.cagrPct)) },
    medianMaxDrawdown: { strategy: med(curves.map((c) => c.strat.maxDDPct)), buyHold: med(curves.map((c) => c.bh.maxDDPct)) },
    namesWithShallowerDrawdown: curves.filter((c) => c.strat.maxDDPct < c.bh.maxDDPct).length,
    namesWithHigherCagr: curves.filter((c) => c.strat.cagrPct > c.bh.cagrPct).length,
    survivorshipBias: 'The universe is today\'s large caps, which by construction survived. Buy-and-hold is flattered; the comparison is directional, not precise.',
  },
};

fs.writeFileSync(OUT, JSON.stringify(calibration, null, 2) + '\n');
console.log(`\n[calibrate] written to ${path.relative(process.cwd(), OUT)}`);
console.log(`   per-trade edge significant: ${calibration.strategyValidation.perTradeEdgeSignificant}`);
console.log(`   beats buy-and-hold on ${calibration.strategyValidation.tickersBeatingBuyAndHold}/${calibration.strategyValidation.tickersCompared} names`);
console.log(`   median CAGR ${calibration.strategyValidation.medianCagr.strategy}% vs ${calibration.strategyValidation.medianCagr.buyHold}% | max DD ${calibration.strategyValidation.medianMaxDrawdown.strategy}% vs ${calibration.strategyValidation.medianMaxDrawdown.buyHold}%`);
process.exit(0);
