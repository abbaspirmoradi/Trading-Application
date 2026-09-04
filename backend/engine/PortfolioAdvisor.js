// Portfolio Advisor.
//
// Runs the full agent pipeline over every holding and converts the results into
// things a human can act on today: what to exit, what to trim, where to move a
// stop, and what deserves more capital. Every alert carries the evidence that
// produced it — no recommendation appears without a reason attached.
//
// Severity ordering is deliberate: CRITICAL items are capital-preservation
// actions (a breached stop, a Stage 4 breakdown, a heat breach). Those come
// before any opportunity, because not losing money outranks making it.

import { runAnalysis } from './ManagerOrchestrator.js';
import { buildMarketContext } from '../data/marketDataService.js';
import { computeExecutionBarriers } from './BarrierEngine.js';
import { mapLimit } from '../lib/concurrency.js';
import { getBars } from '../data/marketDataService.js';
import { closes } from '../lib/indicators.js';
import { correlation } from '../lib/stats.js';
import { RISK } from '../config/constants.js';
import { AGENT_IDS } from '../agents/index.js';

export const SEVERITY = {
  CRITICAL: 'CRITICAL',
  WARNING: 'WARNING',
  OPPORTUNITY: 'OPPORTUNITY',
  INFO: 'INFO',
};

const SEVERITY_RANK = { CRITICAL: 0, WARNING: 1, OPPORTUNITY: 2, INFO: 3 };

const VERDICT = {
  EXIT: 'EXIT',
  TRIM: 'TRIM',
  HOLD: 'HOLD',
  ADD: 'ADD',
};

const usd = (n) => `$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const daysBetween = (a, b) => Math.max(0, Math.round((b - a) / 86400000));

export async function advisePortfolio({
  portfolio,
  activeAgentIds = AGENT_IDS,
  performanceWeights = {},
  concurrency = 4,
}) {
  const positions = portfolio.positions || [];
  const equity = portfolio.equity || 0;
  const alerts = [];

  /* ------------------- per-position analysis ------------------- */
  const reviewed = await mapLimit(positions, concurrency, async (pos) => {
    const ctx = await buildMarketContext(pos.ticker);
    const decision = await runAnalysis({
      ticker: pos.ticker,
      activeAgentIds,
      marketContext: ctx,
      portfolio,
      performanceWeights,
    });

    const price = ctx.price;
    const isLong = pos.side !== 'SHORT';
    const entry = pos.entryPrice;
    const stop = pos.stopPrice;

    const perShare = isLong ? price - entry : entry - price;
    const pnl = perShare * pos.shares;
    const pnlPct = (perShare / entry) * 100;
    const initialRisk = Math.abs(entry - stop);
    const rMultiple = initialRisk ? perShare / initialRisk : 0;
    const marketValue = price * pos.shares;
    const weightPct = equity ? (marketValue / equity) * 100 : 0;
    const openRisk = Math.max(0, isLong ? price - stop : stop - price) * pos.shares;
    const openRiskPct = equity ? (openRisk / equity) * 100 : 0;
    const daysHeld = pos.openedAt ? daysBetween(new Date(pos.openedAt).getTime(), Date.now()) : null;

    const stageAgent = decision.agentBreakdown.find((a) => a.agentId === 'Weinstein_Stage_Agent');
    const stage = stageAgent?.payload?.stage ?? null;
    const barriers = computeExecutionBarriers(ctx, isLong ? 1 : -1, decision.agentBreakdown);

    const positionAlerts = [];
    const add = (severity, code, title, detail, action) =>
      positionAlerts.push({ severity, code, ticker: pos.ticker, title, detail, action });

    // ---- Capital preservation, in priority order ----

    // 1. The stop has already been breached. Nothing else matters.
    const stopBreached = isLong ? price <= stop : price >= stop;
    if (stopBreached) {
      add(SEVERITY.CRITICAL, 'STOP_BREACHED',
        `${pos.ticker} has broken its stop`,
        `Price ${price.toFixed(2)} is ${isLong ? 'at or below' : 'at or above'} your stop of ${stop.toFixed(2)}. The loss is ${usd(pnl)} (${pnlPct.toFixed(1)}%).`,
        'Exit the position. The stop existed to answer this exact situation before it arrived.');
    }

    // 2. Stage 4 while long — the single most reliable exit signal in the system.
    if (isLong && stage === 4 && !stopBreached) {
      add(SEVERITY.CRITICAL, 'STAGE_4_BREAKDOWN',
        `${pos.ticker} has entered a Stage 4 decline`,
        `The 30-week moving average is falling with price beneath it. ${stageAgent.reasoning[0]}`,
        'Exit. Stage 4 is where the largest drawdowns happen, and the system vetoes new buys here.');
    }

    // 3. Stage 3 distribution — the warning that precedes Stage 4.
    if (isLong && stage === 3) {
      add(SEVERITY.WARNING, 'STAGE_3_DISTRIBUTION',
        `${pos.ticker} is showing Stage 3 topping behaviour`,
        `The advance is stalling and the 30-week MA is flattening. ${stageAgent.reasoning[0]}`,
        rMultiple > 1
          ? `Take partial profits and trail the remainder. You are ${rMultiple.toFixed(1)}R up — protect it.`
          : 'Tighten the stop. Do not add.');
    }

    // 4. Profit target reached.
    if (pos.profitTarget && (isLong ? price >= pos.profitTarget : price <= pos.profitTarget)) {
      add(SEVERITY.OPPORTUNITY, 'TARGET_REACHED',
        `${pos.ticker} has reached your profit target`,
        `Price ${price.toFixed(2)} has hit the ${pos.profitTarget.toFixed(2)} target — ${usd(pnl)} open profit (${rMultiple.toFixed(1)}R).`,
        'Take profit on at least part of the position, then trail the rest behind the rising 30-week MA.');
    }

    // 5. The stop can be raised: structure has moved up beneath the position.
    const suggestedStop = barriers?.stopLoss;
    const canTrail = suggestedStop != null
      && (isLong ? suggestedStop > stop && suggestedStop < price : suggestedStop < stop && suggestedStop > price);
    if (canTrail && !stopBreached) {
      const lockedIn = (isLong ? suggestedStop - entry : entry - suggestedStop) * pos.shares;
      add(
        lockedIn > 0 ? SEVERITY.OPPORTUNITY : SEVERITY.INFO,
        'TRAIL_STOP',
        `Raise the stop on ${pos.ticker} to ${suggestedStop.toFixed(2)}`,
        `Structure has moved up beneath the position (${barriers.stopBasis}). Your stop is still at ${stop.toFixed(2)}.`,
        lockedIn > 0
          ? `Moving it locks in ${usd(lockedIn)} and turns this into a risk-free trade.`
          : `Moving it cuts open risk from ${usd(openRisk)} to ${usd(Math.max(0, (price - suggestedStop) * pos.shares))}.`,
      );
    }

    // 6. Time barrier: the thesis has had its window and not delivered.
    if (pos.timeBarrier && new Date(pos.timeBarrier) < new Date() && Math.abs(rMultiple) < 1) {
      add(SEVERITY.WARNING, 'TIME_BARRIER_EXPIRED',
        `${pos.ticker} has passed its time barrier`,
        `Held ${daysHeld} days and still only ${rMultiple.toFixed(1)}R. Capital is committed to a thesis that has not worked.`,
        'Close it and redeploy. Dead money is a real cost, not a neutral outcome.');
    }

    // 7. Position risk exceeds the per-trade ceiling.
    if (openRiskPct > RISK.maxRiskPerTradePct * 1.5) {
      add(SEVERITY.WARNING, 'OVERSIZED_RISK',
        `${pos.ticker} risks ${openRiskPct.toFixed(2)}% of equity`,
        `That is above the ${RISK.maxRiskPerTradePct}% per-trade policy — ${usd(openRisk)} is exposed between here and the stop.`,
        'Reduce the share count, or raise the stop if structure allows.');
    }

    // 8. Concentration.
    if (weightPct > RISK.hardMaxPositionPct * 1.2) {
      add(SEVERITY.WARNING, 'CONCENTRATION',
        `${pos.ticker} is ${weightPct.toFixed(1)}% of the portfolio`,
        `The single-idea ceiling is ${RISK.hardMaxPositionPct}%. A gap down in one name should never be able to define your year.`,
        'Trim back toward the ceiling on the next strength.');
    }

    // 9. The thesis is deteriorating even though no hard rule has fired yet.
    if (isLong && decision.compositeScore < -20 && stage !== 4 && !stopBreached) {
      add(SEVERITY.WARNING, 'THESIS_DETERIORATING',
        `${pos.ticker} consensus has turned negative (${decision.compositeScore})`,
        `${decision.consensus.bearishCount} of ${decision.consensus.votingAgentCount} voting agents are now bearish.`,
        'Tighten the stop and stop adding. The evidence that justified the entry is eroding.');
    }

    // 10. Adding is justified — but only if every hard rule still passes.
    const canAdd = isLong
      && !decision.blocked
      && ['BUY', 'STRONG_BUY'].includes(decision.finalAction)
      && (decision.positionSizing?.suggestedShares ?? 0) > 0
      && !stopBreached;
    if (canAdd) {
      add(SEVERITY.OPPORTUNITY, 'ADD_TO_WINNER',
        `${pos.ticker} supports adding ${decision.positionSizing.suggestedShares} more shares`,
        `Composite ${decision.compositeScore > 0 ? '+' : ''}${decision.compositeScore}, P(profit) ${(decision.probabilityOfProfit * 100).toFixed(0)}%, and no veto fired. Headroom remains under the ${RISK.hardMaxPositionPct}% ceiling.`,
        `Add up to ${decision.positionSizing.suggestedShares} shares (${usd(decision.positionSizing.allocationDollar)}) with a stop at ${barriers?.stopLoss?.toFixed(2)}.`);
    }

    // Verdict is the strongest action implied by the alerts.
    let verdict = VERDICT.HOLD;
    if (positionAlerts.some((a) => ['STOP_BREACHED', 'STAGE_4_BREAKDOWN'].includes(a.code))) verdict = VERDICT.EXIT;
    else if (positionAlerts.some((a) => ['STAGE_3_DISTRIBUTION', 'TARGET_REACHED', 'CONCENTRATION', 'TIME_BARRIER_EXPIRED', 'OVERSIZED_RISK'].includes(a.code))) verdict = VERDICT.TRIM;
    else if (positionAlerts.some((a) => a.code === 'ADD_TO_WINNER')) verdict = VERDICT.ADD;

    alerts.push(...positionAlerts);

    return {
      ticker: pos.ticker,
      positionId: pos._id,
      side: pos.side || 'LONG',
      shares: pos.shares,
      entryPrice: entry,
      currentPrice: price,
      stopPrice: stop,
      suggestedStop: canTrail ? Number(suggestedStop.toFixed(2)) : null,
      profitTarget: pos.profitTarget ?? barriers?.profitTarget ?? null,
      marketValue: Number(marketValue.toFixed(2)),
      unrealizedPnl: Number(pnl.toFixed(2)),
      unrealizedPnlPct: Number(pnlPct.toFixed(2)),
      rMultiple: Number(rMultiple.toFixed(2)),
      weightPct: Number(weightPct.toFixed(2)),
      openRisk: Number(openRisk.toFixed(2)),
      openRiskPct: Number(openRiskPct.toFixed(3)),
      daysHeld,
      stage,
      compositeScore: decision.compositeScore,
      probabilityOfProfit: decision.probabilityOfProfit,
      rsRating: decision.agentBreakdown.find((a) => a.agentId === 'Relative_Strength_Agent')?.payload?.rsRating ?? null,
      verdict,
      alerts: positionAlerts,
      dataSources: decision.dataSources,
    };
  });

  const holdings = reviewed.filter((r) => r && !r.error);
  const failures = reviewed.filter((r) => r && r.error);

  /* ------------------- portfolio-level checks ------------------- */
  const heat = portfolio.portfolioHeatPct ?? 0;
  const drawdown = portfolio.drawdownPct ?? 0;
  const grossExposurePct = equity ? (holdings.reduce((a, h) => a + h.marketValue, 0) / equity) * 100 : 0;

  const pAlert = (severity, code, title, detail, action) => alerts.push({ severity, code, ticker: null, title, detail, action });

  if (heat >= RISK.maxPortfolioHeatPct) {
    pAlert(SEVERITY.CRITICAL, 'PORTFOLIO_HEAT_BREACH',
      `Portfolio heat is ${heat.toFixed(2)}%, at or above the ${RISK.maxPortfolioHeatPct}% ceiling`,
      `${usd((heat / 100) * equity)} is at risk between current prices and your stops. If every stop hit at once, that is the loss.`,
      'Add no new risk. Tighten stops on the weakest holdings, or close one outright.');
  } else if (heat > RISK.maxPortfolioHeatPct * 0.75) {
    pAlert(SEVERITY.WARNING, 'PORTFOLIO_HEAT_ELEVATED',
      `Portfolio heat is ${heat.toFixed(2)}% of the ${RISK.maxPortfolioHeatPct}% budget`,
      `Roughly ${(RISK.maxPortfolioHeatPct - heat).toFixed(2)}% of heat headroom remains — about one more full-size position.`,
      'Be selective. The next entry should be your best idea, not your next idea.');
  }

  if (drawdown >= RISK.deleverageDrawdownPct) {
    pAlert(SEVERITY.CRITICAL, 'DRAWDOWN_DELEVERAGE',
      `Account is ${drawdown.toFixed(2)}% below its peak`,
      `The de-leverage threshold is ${RISK.deleverageDrawdownPct}%. Drawdowns compound psychologically as well as financially.`,
      'Halve position sizes until the equity curve makes a new high. Trade smaller, not more.');
  }

  // Correlation clustering. A book of eight names that all move together is one
  // bet held eight times — the single most under-appreciated portfolio risk, and
  // the reason a "diversified" account can lose everything in one session.
  const correlationReport = await analyseCorrelations(holdings);
  for (const pair of correlationReport.dangerousPairs) {
    pAlert(SEVERITY.WARNING, 'CORRELATION_CLUSTER',
      `${pair.a} and ${pair.b} move together (correlation ${pair.value.toFixed(2)})`,
      `Combined they are ${pair.combinedWeightPct.toFixed(1)}% of the portfolio. Above ${RISK.correlationVetoThreshold} these are effectively one position, and they will draw down as one.`,
      'Treat them as a single idea when sizing. Consider closing the weaker of the two.');
  }
  if (correlationReport.averageCorrelation > 0.6 && holdings.length >= 3) {
    pAlert(SEVERITY.WARNING, 'PORTFOLIO_UNDIVERSIFIED',
      `Average pairwise correlation is ${correlationReport.averageCorrelation.toFixed(2)}`,
      `Across ${holdings.length} holdings, the book behaves like roughly ${correlationReport.effectiveBets.toFixed(1)} independent bet${correlationReport.effectiveBets < 1.5 ? '' : 's'}.`,
      'Diversify into something that does not trade off the same driver, or accept that this is a concentrated position and size it as one.');
  }

  if (grossExposurePct > 100) {
    pAlert(SEVERITY.WARNING, 'LEVERAGE_IN_USE',
      `Gross exposure is ${grossExposurePct.toFixed(0)}% of equity`,
      'Positions total more than the account. Losses are amplified in both directions.',
      'Confirm this is intentional; if not, reduce until exposure is under 100%.');
  }

  if (holdings.length === 0) {
    pAlert(SEVERITY.INFO, 'NO_POSITIONS',
      'No open positions',
      'There is nothing to manage yet. Add your holdings, or use Daily Picks to find a first candidate.',
      'Cash is a position. Holding it while nothing sets up is a decision, not indecision.');
  } else if (grossExposurePct < 20) {
    pAlert(SEVERITY.INFO, 'LOW_DEPLOYMENT',
      `Only ${grossExposurePct.toFixed(0)}% of the account is deployed`,
      `${usd(portfolio.cash)} is sitting in cash.`,
      'Fine if nothing qualifies. Check Daily Picks for setups that clear every veto.');
  }

  for (const f of failures) {
    pAlert(SEVERITY.WARNING, 'DATA_UNAVAILABLE',
      `Could not analyse ${f.item?.ticker ?? 'a holding'}`,
      f.error,
      'The position is excluded from this review. Verify the symbol.');
  }

  alerts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const counts = {
    critical: alerts.filter((a) => a.severity === SEVERITY.CRITICAL).length,
    warning: alerts.filter((a) => a.severity === SEVERITY.WARNING).length,
    opportunity: alerts.filter((a) => a.severity === SEVERITY.OPPORTUNITY).length,
    info: alerts.filter((a) => a.severity === SEVERITY.INFO).length,
  };

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      positions: holdings.length,
      equity,
      cash: portfolio.cash,
      grossExposurePct: Number(grossExposurePct.toFixed(1)),
      portfolioHeatPct: Number(heat.toFixed(2)),
      heatLimitPct: RISK.maxPortfolioHeatPct,
      drawdownPct: Number(drawdown.toFixed(2)),
      totalUnrealizedPnl: Number(holdings.reduce((a, h) => a + h.unrealizedPnl, 0).toFixed(2)),
      totalOpenRisk: Number(holdings.reduce((a, h) => a + h.openRisk, 0).toFixed(2)),
      verdicts: {
        EXIT: holdings.filter((h) => h.verdict === 'EXIT').length,
        TRIM: holdings.filter((h) => h.verdict === 'TRIM').length,
        HOLD: holdings.filter((h) => h.verdict === 'HOLD').length,
        ADD: holdings.filter((h) => h.verdict === 'ADD').length,
      },
      alertCounts: counts,
    },
    headline: buildHeadline(counts, holdings),
    correlations: correlationReport,
    alerts,
    holdings,
  };
}

/**
 * Pairwise correlation of daily returns across holdings, plus a crude
 * "effective number of bets" = N / (1 + (N-1) * average correlation). At an
 * average correlation of 1.0 that collapses to 1, which is the honest reading.
 */
async function analyseCorrelations(holdings) {
  const empty = { averageCorrelation: 0, effectiveBets: holdings.length, dangerousPairs: [], matrix: [] };
  if (holdings.length < 2) return empty;

  const series = {};
  await mapLimit(holdings, 4, async (h) => {
    try {
      const bars = await getBars(h.ticker, 200);
      const px = closes(bars);
      const rets = [];
      for (let i = 1; i < px.length; i++) rets.push(px[i] / px[i - 1] - 1);
      series[h.ticker] = rets.slice(-120);
    } catch {
      series[h.ticker] = null;
    }
  });

  const pairs = [];
  const matrix = holdings.map((a) => ({
    ticker: a.ticker,
    correlations: holdings.map((b) => ({
      ticker: b.ticker,
      value: a.ticker === b.ticker ? 1
        : Number((series[a.ticker] && series[b.ticker] ? correlation(series[a.ticker], series[b.ticker]) : 0).toFixed(3)),
    })),
  }));

  for (let i = 0; i < holdings.length; i++) {
    for (let j = i + 1; j < holdings.length; j++) {
      const value = matrix[i].correlations[j].value;
      pairs.push({
        a: holdings[i].ticker,
        b: holdings[j].ticker,
        value,
        combinedWeightPct: holdings[i].weightPct + holdings[j].weightPct,
      });
    }
  }

  const avg = pairs.length ? pairs.reduce((acc, p) => acc + p.value, 0) / pairs.length : 0;
  const n = holdings.length;
  const effectiveBets = avg <= -1 / (n - 1) ? n : n / (1 + (n - 1) * Math.max(0, avg));

  return {
    averageCorrelation: Number(avg.toFixed(3)),
    effectiveBets: Number(effectiveBets.toFixed(2)),
    dangerousPairs: pairs.filter((p) => Math.abs(p.value) > RISK.correlationVetoThreshold).sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
    matrix,
  };
}

function buildHeadline(counts, holdings) {
  if (counts.critical > 0) {
    return `${counts.critical} position${counts.critical === 1 ? '' : 's'} need${counts.critical === 1 ? 's' : ''} immediate action. Deal with those before anything else.`;
  }
  if (counts.warning > 0) {
    return `No emergencies. ${counts.warning} item${counts.warning === 1 ? '' : 's'} need attention this week.`;
  }
  if (counts.opportunity > 0) {
    return `Portfolio is healthy. ${counts.opportunity} opportunit${counts.opportunity === 1 ? 'y' : 'ies'} available.`;
  }
  return holdings.length
    ? 'Portfolio is healthy and requires no action today. Doing nothing is the correct trade.'
    : 'No positions yet.';
}
