import { BaseAgent, gradeLinear } from './BaseAgent.js';
import { CLUSTERS, RISK, BARRIERS } from '../config/constants.js';
import { closes, sma, atr, toWeekly } from '../lib/indicators.js';
import { correlation, clamp } from '../lib/stats.js';
import { getBars } from '../data/marketDataService.js';

/* ------------------------------------------------------------------ *
 * 10. Portfolio Risk — the gatekeeper
 * ------------------------------------------------------------------ */

/**
 * The ultimate gatekeeper. Enforces the two non-negotiable rules:
 *   1. Never risk more than ~1% of equity on a single idea (hard ceiling 2%).
 *   2. Never allocate more than 5% of equity to any one idea, regardless of
 *      how attractive the setup looks.
 * On top of that it studies the correlation of the candidate against every open
 * position — three highly-correlated winners are one position wearing three
 * hats, and that is how accounts blow up.
 */
export class PortfolioRiskAgent extends BaseAgent {
  constructor() {
    super({
      id: 'Portfolio_Risk_Agent',
      name: 'Portfolio Risk & Correlation',
      cluster: CLUSTERS.RISK,
      description: 'Cross-correlation matrix, portfolio heat, per-trade dollar risk ceiling, concentration limits.',
    });
  }

  async analyze(ctx) {
    const pf = ctx.portfolio || { equity: 100000, cash: 100000, positions: [] };
    const equity = pf.equity || 100000;
    const positions = pf.positions || [];

    // Open risk per position = distance to stop x shares (floored at zero for
    // positions already trailing above entry).
    let openRisk = 0;
    for (const p of positions) {
      const px = p.currentPrice ?? p.entryPrice;
      const perShare = p.side === 'SHORT' ? (p.stopPrice - px) : (px - p.stopPrice);
      openRisk += Math.max(0, perShare) * p.shares;
    }
    const portfolioHeatPct = (openRisk / equity) * 100;

    // An existing position in the same security is an ADD, not a correlated
    // second idea. It is handled by the position cap (the combined holding must
    // still fit inside the 5% ceiling), never by the correlation veto — which
    // would otherwise reject every pyramid at a self-correlation of 1.00.
    const existing = positions.filter((p) => p.ticker === ctx.ticker);
    const existingValue = existing.reduce((a, p) => a + (p.currentPrice ?? p.entryPrice) * p.shares, 0);
    const existingShares = existing.reduce((a, p) => a + p.shares, 0);

    // Correlation of daily returns over the last 120 sessions, across the
    // genuinely distinct holdings.
    const candidateReturns = dailyReturns(ctx.bars, 120);
    const correlations = [];
    for (const p of positions) {
      if (p.ticker === ctx.ticker) {
        correlations.push({ ticker: p.ticker, correlation: 1, note: 'same security — treated as an add, excluded from the correlation test' });
        continue;
      }
      try {
        const bars = await getBars(p.ticker, 260);
        const r = correlation(candidateReturns, dailyReturns(bars, 120));
        correlations.push({ ticker: p.ticker, correlation: Number(r.toFixed(3)) });
      } catch {
        correlations.push({ ticker: p.ticker, correlation: 0, note: 'price history unavailable' });
      }
    }

    const distinct = correlations.filter((c) => c.ticker !== ctx.ticker);
    const maxCorrelation = distinct.length ? Math.max(...distinct.map((c) => Math.abs(c.correlation))) : 0;
    const worst = distinct.find((c) => Math.abs(c.correlation) === maxCorrelation);

    const exposurePct = positions.reduce((a, p) => a + ((p.currentPrice ?? p.entryPrice) * p.shares), 0) / equity * 100;

    const maxRiskDollar = equity * (RISK.maxRiskPerTradePct / 100);
    // Headroom left under the 5% ceiling once the existing holding is counted.
    const positionCeiling = equity * (RISK.hardMaxPositionPct / 100);
    const maxPositionDollar = Math.max(0, positionCeiling - existingValue);
    const positionCapExhausted = maxPositionDollar <= 0;
    const remainingHeatPct = Math.max(0, RISK.maxPortfolioHeatPct - portfolioHeatPct);
    const heatBreach = portfolioHeatPct >= RISK.maxPortfolioHeatPct;
    const correlationBreach = maxCorrelation > RISK.correlationVetoThreshold;
    const approved = !heatBreach && !correlationBreach && !positionCapExhausted;

    let score = 0;
    score += gradeLinear(-portfolioHeatPct, -RISK.maxPortfolioHeatPct, 0) * 0.45;
    score += gradeLinear(-maxCorrelation, -0.85, -0.2) * 0.35;
    score += gradeLinear(-exposurePct, -140, -20) * 0.20;
    if (heatBreach) score = Math.min(score, -70);
    if (correlationBreach) score = Math.min(score, -60);
    score = clamp(score, -100, 100);

    const reasoning = [
      `Portfolio heat ${portfolioHeatPct.toFixed(2)}% of ${fmtUsd(equity)} equity at risk across ${positions.length} open position${positions.length === 1 ? '' : 's'} (limit ${RISK.maxPortfolioHeatPct}%)`,
      `Maximum permitted risk on this idea: ${fmtUsd(maxRiskDollar)} (${RISK.maxRiskPerTradePct}% of equity); position value capped at ${RISK.hardMaxPositionPct}% = ${fmtUsd(positionCeiling)}`,
      distinct.length
        ? `Highest correlation to a distinct holding: ${maxCorrelation.toFixed(2)} vs ${worst?.ticker} — ${correlationBreach ? `EXCEEDS the ${RISK.correlationVetoThreshold} limit, this duplicates existing risk` : 'within limits, adds genuine diversification'}`
        : 'No distinct holdings to correlate against — no concentration constraint on this idea',
      `Gross exposure ${exposurePct.toFixed(1)}% of equity; ${remainingHeatPct.toFixed(2)}% of heat budget remains`,
    ];
    if (existingShares > 0) {
      reasoning.push(
        positionCapExhausted
          ? `Already holding ${existingShares} shares worth ${fmtUsd(existingValue)} — the ${RISK.hardMaxPositionPct}% position ceiling is exhausted, no further adds permitted`
          : `Already holding ${existingShares} shares worth ${fmtUsd(existingValue)}; ${fmtUsd(maxPositionDollar)} of headroom remains under the ${RISK.hardMaxPositionPct}% ceiling for an add`,
      );
    }
    if (heatBreach) reasoning.push(`RISK VIOLATION: portfolio heat has reached the ${RISK.maxPortfolioHeatPct}% ceiling — no new risk may be added until existing stops tighten`);
    if (!approved) reasoning.push('Trade REJECTED by the risk gate');

    return {
      score,
      confidence: 0.9, // risk arithmetic is deterministic, not a forecast
      reasoning,
      metrics: {
        equity,
        openRiskDollar: Number(openRisk.toFixed(2)),
        portfolioHeatPct: Number(portfolioHeatPct.toFixed(2)),
        maxRiskDollar: Number(maxRiskDollar.toFixed(2)),
        maxPositionDollar: Number(maxPositionDollar.toFixed(2)),
        existingShares,
        existingPositionValue: Number(existingValue.toFixed(2)),
        positionCapExhausted,
        grossExposurePct: Number(exposurePct.toFixed(1)),
        maxCorrelation: Number(maxCorrelation.toFixed(3)),
        correlationMatrix: correlations,
        remainingHeatPct: Number(remainingHeatPct.toFixed(2)),
        approved,
        correlationHazard: correlationBreach ? 'OVER_CONCENTRATED' : 'PASSED',
      },
      payload: {
        approved, heatBreach, correlationBreach, maxCorrelation,
        portfolioHeatPct, maxRiskDollar, equity,
        maxPositionDollar,
        existingShares, existingValue, positionCapExhausted,
      },
    };
  }
}

function dailyReturns(bars, n) {
  const px = closes(bars).slice(-(n + 1));
  const out = [];
  for (let i = 1; i < px.length; i++) out.push(px[i] / px[i - 1] - 1);
  return out;
}

const fmtUsd = (x) => `$${Math.round(x).toLocaleString('en-US')}`;

/* ------------------------------------------------------------------ *
 * 11. Triple Barrier & Dynamic Exit
 * ------------------------------------------------------------------ */

/**
 * The triple-barrier method: every trade is bounded by a profit-taking barrier,
 * a stop-loss barrier and a vertical (time) barrier. Whichever is touched first
 * closes the trade — no open-ended positions, no hoping.
 *
 * The stop prefers *structure* (prior reaction low, rising 30-week MA) over a
 * pure volatility multiple, falling back to an ATR stop when structure sits too
 * far away to be economic.
 */
export class TripleBarrierExitAgent extends BaseAgent {
  constructor() {
    super({
      id: 'Triple_Barrier_Exit_Agent',
      name: 'Triple Barrier & Dynamic Exit',
      cluster: CLUSTERS.EXECUTION,
      description: 'Volatility-adjusted profit target, structural stop below the 30-week MA / reaction low, time barrier.',
    });
  }

  async analyze(ctx) {
    const bars = ctx.bars;
    const price = ctx.price;
    const atrSeries = atr(bars, BARRIERS.atrPeriod);
    const atrNow = atrSeries.at(-1);
    if (!atrNow) throw new Error('insufficient history for ATR');

    const weekly = toWeekly(bars);
    const ma30w = sma(closes(weekly), 30).at(-1) ?? null;

    // Direction is inferred from structure so the agent stays independent of
    // the others; the orchestrator overrides it with the consensus direction.
    const direction = ma30w != null && price > ma30w ? 'LONG' : 'SHORT';

    const swingLow = Math.min(...bars.slice(-20).map((b) => b.low));
    const swingHigh = Math.max(...bars.slice(-20).map((b) => b.high));
    const atrPct = (atrNow / price) * 100;

    const barriers = buildBarriers({ price, atrNow, ma30w, swingLow, swingHigh, direction });

    const reasoning = [
      `Direction ${direction} inferred from price vs the 30-week MA (${ma30w ? ma30w.toFixed(2) : 'n/a'})`,
      `ATR(${BARRIERS.atrPeriod}) ${atrNow.toFixed(2)} = ${atrPct.toFixed(2)}% of price — ${atrPct > 4 ? 'high volatility, size down accordingly' : atrPct < 1.5 ? 'tight volatility, a close stop is viable' : 'normal volatility'}`,
      `Lower barrier (stop) ${barriers.stopLoss.toFixed(2)} via ${barriers.stopBasis} — ${barriers.riskPct.toFixed(2)}% of price at risk`,
      `Upper barrier (target) ${barriers.profitTarget.toFixed(2)} at ${BARRIERS.profitAtrMultiple}x ATR — ${barriers.rewardPct.toFixed(2)}% upside`,
      `Vertical barrier: ${BARRIERS.maxHoldingDays} trading days, expiring ${barriers.timeBarrier}`,
      `Reward:risk ${barriers.riskRewardRatio.toFixed(2)}:1 — ${barriers.riskRewardRatio >= BARRIERS.minRewardRisk ? 'clears' : 'FAILS'} the ${BARRIERS.minRewardRisk}:1 minimum`,
    ];

    const score = clamp(
      gradeLinear(barriers.riskRewardRatio, 1.0, 3.5) * 0.7
      + gradeLinear(-atrPct, -6, -1.5) * 0.3,
      -100, 100,
    ) * (direction === 'LONG' ? 1 : -1);

    return {
      score,
      confidence: clamp(0.5 + Math.min(barriers.riskRewardRatio / 8, 0.35), 0, 0.9),
      reasoning,
      metrics: {
        direction,
        atr: Number(atrNow.toFixed(2)),
        atrPercent: Number(atrPct.toFixed(2)),
        ma30Week: ma30w ? Number(ma30w.toFixed(2)) : null,
        swingLow: Number(swingLow.toFixed(2)),
        swingHigh: Number(swingHigh.toFixed(2)),
        ...barriers,
      },
      payload: { ...barriers, atr: atrNow, ma30w, direction },
    };
  }
}

/**
 * Shared barrier construction — also called by the orchestrator once the
 * consensus direction is known, so the execution plan and this agent's card
 * always use identical arithmetic.
 */
export function buildBarriers({ price, atrNow, ma30w, swingLow, swingHigh, direction, patternInvalidation = null }) {
  const atrStop = direction === 'LONG'
    ? price - BARRIERS.stopAtrMultiple * atrNow
    : price + BARRIERS.stopAtrMultiple * atrNow;

  // Structural candidates, in Weinstein's order of preference.
  const structural = [];
  if (direction === 'LONG') {
    if (swingLow < price) structural.push({ level: swingLow * 0.985, basis: 'prior reaction low' });
    if (ma30w != null && ma30w < price) structural.push({ level: ma30w * 0.97, basis: 'below the rising 30-week MA' });
    if (patternInvalidation != null && patternInvalidation < price) structural.push({ level: patternInvalidation * 0.99, basis: 'pattern invalidation level' });
  } else {
    if (swingHigh > price) structural.push({ level: swingHigh * 1.015, basis: 'prior reaction high' });
    if (ma30w != null && ma30w > price) structural.push({ level: ma30w * 1.03, basis: 'above the falling 30-week MA' });
    if (patternInvalidation != null && patternInvalidation > price) structural.push({ level: patternInvalidation * 1.01, basis: 'pattern invalidation level' });
  }

  // Prefer the tightest structural stop, subject to two bounds:
  //   * not more than 1.6x further than the volatility stop (too expensive), and
  //   * not closer than 0.8x ATR (inside the noise band, so it gets whipsawed
  //     out on an ordinary session and flatters the reward:risk ratio).
  let stopLoss = atrStop;
  let stopBasis = `${BARRIERS.stopAtrMultiple}x ATR volatility stop`;
  const atrDistance = Math.abs(price - atrStop);
  const minDistance = atrNow * BARRIERS.minStopAtrMultiple;
  const viable = structural
    .map((s) => ({ ...s, distance: Math.abs(price - s.level) }))
    .filter((s) => s.distance >= minDistance && s.distance <= atrDistance * 1.6)
    .sort((a, b) => a.distance - b.distance);
  if (viable.length) {
    stopLoss = viable[0].level;
    stopBasis = viable[0].basis;
  }

  const profitTarget = direction === 'LONG'
    ? price + BARRIERS.profitAtrMultiple * atrNow
    : price - BARRIERS.profitAtrMultiple * atrNow;

  const risk = Math.abs(price - stopLoss);
  const reward = Math.abs(profitTarget - price);

  const expiry = new Date();
  expiry.setDate(expiry.getDate() + Math.round(BARRIERS.maxHoldingDays * 1.4)); // trading days -> calendar

  return {
    direction,
    stopLoss: round2(stopLoss),
    stopBasis,
    profitTarget: round2(profitTarget),
    // A scale-out level at half the measured move keeps the average exit honest.
    profitTarget1: round2(direction === 'LONG' ? price + 2 * atrNow : price - 2 * atrNow),
    timeBarrier: expiry.toISOString().slice(0, 10),
    maxHoldingDays: BARRIERS.maxHoldingDays,
    riskPerShare: round2(risk),
    rewardPerShare: round2(reward),
    riskPct: Number(((risk / price) * 100).toFixed(2)),
    rewardPct: Number(((reward / price) * 100).toFixed(2)),
    riskRewardRatio: Number((reward / (risk || 1e-9)).toFixed(2)),
  };
}

const round2 = (x) => Number(x.toFixed(2));
