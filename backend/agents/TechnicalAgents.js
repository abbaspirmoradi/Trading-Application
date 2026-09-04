import { BaseAgent, gradeLinear } from './BaseAgent.js';
import { CLUSTERS, BREAKOUT, SIGNALS } from '../config/constants.js';
import {
  closes, volumes, sma, rsi, macd, slopePercent, pivots, toWeekly,
  rollingMax, orderFlowImbalance,
} from '../lib/indicators.js';
import { mean, clamp } from '../lib/stats.js';

/* ------------------------------------------------------------------ *
 * 2. Weinstein Stage Analysis
 * ------------------------------------------------------------------ */

/**
 * Classifies the chart into one of Weinstein's four stages using the 30-week
 * moving average, its slope, and the price's position relative to it.
 *
 *   Stage 1 Basing      — flat MA, price oscillating around it, after a decline
 *   Stage 2 Advancing   — rising MA, price above it
 *   Stage 3 Topping     — flattening MA, price stalling/rolling over, after an advance
 *   Stage 4 Declining   — falling MA, price below it
 *
 * This agent is the source of the orchestrator's hard Stage-4 veto.
 */
export class WeinsteinStageAgent extends BaseAgent {
  constructor() {
    super({
      id: 'Weinstein_Stage_Agent',
      name: 'Weinstein Stage Analysis',
      cluster: CLUSTERS.TECHNICAL,
      description: '30-week MA slope and price position to classify Stage 1-4.',
    });
  }

  async analyze(ctx) {
    const weekly = toWeekly(ctx.bars);
    if (weekly.length < 40) throw new Error('insufficient weekly history for 30-week MA');

    const wCloses = closes(weekly);
    const ma30 = sma(wCloses, 30);
    const ma30Now = ma30.at(-1);
    const price = wCloses.at(-1);

    // Slope measured over the last 8 weeks, normalised to % per week.
    const maSlopePct = slopePercent(ma30.filter((x) => x != null), 8);
    const priceVsMaPct = ((price - ma30Now) / ma30Now) * 100;

    // Prior trend distinguishes a base (Stage 1) from a top (Stage 3).
    const priorTrendPct = weekly.length > 60
      ? (wCloses.at(-30) / wCloses.at(-60) - 1) * 100
      : 0;

    const FLAT = 0.15; // % per week considered "flat"
    let stage;
    let stageName;
    if (maSlopePct > FLAT && priceVsMaPct > -2) {
      stage = 2; stageName = 'ADVANCING';
    } else if (maSlopePct < -FLAT && priceVsMaPct < 2) {
      stage = 4; stageName = 'DECLINING';
    } else if (priorTrendPct > 12) {
      stage = 3; stageName = 'TOPPING';
    } else {
      stage = 1; stageName = 'BASING';
    }

    // A breakout from a base into Stage 2 is the highest-value transition.
    const stageMaturityWeeks = weeksInStage(wCloses, ma30, stage);
    const justBrokeOut = stage === 2 && stageMaturityWeeks <= 6;

    const base = { 1: 10, 2: 70, 3: -35, 4: -85 }[stage];
    let score = base
      + clamp(maSlopePct * 12, -25, 25)
      + clamp(priceVsMaPct * 0.6, -12, 12);
    if (justBrokeOut) score += 12;
    score = clamp(score, -100, 100);

    const reasoning = [
      `Stage ${stage} (${stageName}): price ${priceVsMaPct >= 0 ? 'above' : 'below'} the 30-week MA by ${Math.abs(priceVsMaPct).toFixed(1)}%`,
      `30-week MA slope is ${maSlopePct >= 0 ? '+' : ''}${maSlopePct.toFixed(2)}% per week (${Math.abs(maSlopePct) <= FLAT ? 'flat' : maSlopePct > 0 ? 'rising' : 'falling'})`,
      `Approximately ${stageMaturityWeeks} weeks in the current stage`,
    ];
    if (stage === 2) reasoning.push(justBrokeOut ? 'Fresh Stage 2 breakout — the highest-expectancy window for new entries' : 'Established Stage 2 advance — add on pullbacks to the rising MA, not on extension');
    if (stage === 4) reasoning.push('Stage 4 decline: all long entries are vetoed regardless of other agent scores');
    if (stage === 3) reasoning.push('Stage 3 distribution: tighten trailing stops, no new longs');
    if (stage === 1) reasoning.push('Stage 1 base: wait for a volume-backed breakout above the base ceiling');

    return {
      score,
      confidence: clamp(0.5 + Math.min(Math.abs(maSlopePct) * 1.2, 0.35) + (stage === 2 || stage === 4 ? 0.1 : 0), 0, 0.95),
      reasoning,
      metrics: {
        stage,
        stageName,
        ma30Week: Number(ma30Now.toFixed(2)),
        maSlopePctPerWeek: Number(maSlopePct.toFixed(3)),
        priceVsMaPct: Number(priceVsMaPct.toFixed(2)),
        weeksInStage: stageMaturityWeeks,
      },
      payload: {
        stage,
        stageName,
        ma30Week: ma30Now,
        maSlopePct,
        priceVsMaPct,
        freshBreakout: justBrokeOut,
      },
    };
  }
}

function weeksInStage(wCloses, ma30, stage) {
  let count = 0;
  for (let i = ma30.length - 1; i >= 1; i--) {
    if (ma30[i] == null || ma30[i - 1] == null) break;
    const rising = ma30[i] > ma30[i - 1];
    const above = wCloses[i] > ma30[i];
    const s = rising && above ? 2 : !rising && !above ? 4 : above ? 3 : 1;
    if (s !== stage) break;
    count++;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * 3. Chart Pattern & Breakout
 * ------------------------------------------------------------------ */

/**
 * Algorithmic recognition of the classic high-probability structures. Each
 * detector returns a breakout level, a measured-move target and the price that
 * invalidates the pattern, so the orchestrator can build an execution plan
 * directly from the winning candidate.
 */
export class ChartPatternAgent extends BaseAgent {
  constructor() {
    super({
      id: 'Chart_Pattern_Agent',
      name: 'Chart Pattern & Breakout',
      cluster: CLUSTERS.TECHNICAL,
      description: 'Cup-with-handle, double bottom, head & shoulders, flat base and consolidation detection.',
    });
  }

  async analyze(ctx) {
    const bars = ctx.bars;
    const price = ctx.price;
    const { highs: ph, lows: pl } = pivots(bars, 5);

    const candidates = [
      detectFlatBase(bars, price),
      detectCupWithHandle(bars, ph, pl, price),
      detectDoubleBottom(bars, ph, pl, price),
      detectHeadAndShoulders(bars, ph, pl, price, 'TOP'),
      detectHeadAndShoulders(bars, ph, pl, price, 'BOTTOM'),
    ].filter(Boolean);

    if (!candidates.length) {
      return {
        score: 0,
        confidence: 0.3,
        signal: SIGNALS.NEUTRAL,
        reasoning: ['No high-probability pattern currently resolvable in the price structure', 'Price action is unstructured — wait for a base to form'],
        metrics: { patternsFound: 0 },
        payload: { pattern: null },
      };
    }

    candidates.sort((a, b) => b.quality - a.quality);
    const best = candidates[0];
    const direction = best.direction;

    const distanceToTrigger = ((best.breakoutLevel - price) / price) * 100;
    const score = clamp((direction === 'LONG' ? 1 : -1) * best.quality * 100, -100, 100);

    const reasoning = [
      `${best.name} detected (${direction}), pattern quality ${(best.quality * 100).toFixed(0)}/100`,
      `Breakout trigger ${best.breakoutLevel.toFixed(2)} — ${Math.abs(distanceToTrigger).toFixed(1)}% ${distanceToTrigger > 0 ? 'above' : 'below'} spot`,
      `Measured-move target ${best.target.toFixed(2)}; pattern fails below ${best.invalidation.toFixed(2)}`,
      ...best.notes,
    ];
    if (candidates.length > 1) reasoning.push(`Secondary structure: ${candidates[1].name}`);

    return {
      score,
      confidence: clamp(0.3 + best.quality * 0.6, 0, 0.92),
      reasoning,
      metrics: {
        pattern: best.name,
        direction,
        breakoutLevel: Number(best.breakoutLevel.toFixed(2)),
        target: Number(best.target.toFixed(2)),
        invalidation: Number(best.invalidation.toFixed(2)),
        patternQuality: Number(best.quality.toFixed(2)),
        distanceToTriggerPct: Number(distanceToTrigger.toFixed(2)),
        patternsFound: candidates.length,
      },
      payload: {
        pattern: best.name,
        direction,
        breakoutLevel: best.breakoutLevel,
        target: best.target,
        invalidation: best.invalidation,
        quality: best.quality,
      },
    };
  }
}

function detectFlatBase(bars, price) {
  const win = bars.slice(-35);
  if (win.length < 25) return null;
  const hi = Math.max(...win.map((b) => b.high));
  const lo = Math.min(...win.map((b) => b.low));
  const depth = ((hi - lo) / hi) * 100;
  if (depth > 18) return null; // too loose to be a base

  const positionInBase = (price - lo) / (hi - lo);
  const quality = clamp((1 - depth / 18) * 0.6 + positionInBase * 0.4, 0, 1);
  return {
    name: 'Flat Base / Consolidation',
    direction: 'LONG',
    breakoutLevel: hi,
    target: hi + (hi - lo),
    invalidation: lo,
    quality,
    notes: [`Base depth ${depth.toFixed(1)}% over ${win.length} sessions; price sits in the ${(positionInBase * 100).toFixed(0)}th percentile of the range`],
  };
}

function detectCupWithHandle(bars, ph, pl, price) {
  if (ph.length < 2 || pl.length < 1) return null;
  const n = bars.length;

  // Left rim: a pivot high 30-160 bars back. Cup bottom: the lowest low after it.
  const leftRim = [...ph].reverse().find((p) => n - p.index >= 30 && n - p.index <= 160);
  if (!leftRim) return null;

  const after = bars.slice(leftRim.index);
  const bottomIdx = leftRim.index + after.reduce((best, b, i) => (b.low < after[best].low ? i : best), 0);
  const bottom = bars[bottomIdx].low;
  const depth = ((leftRim.price - bottom) / leftRim.price) * 100;
  if (depth < 10 || depth > 50) return null; // not a cup

  // Right side must recover to within 10% of the left rim.
  const rightSide = bars.slice(bottomIdx);
  if (rightSide.length < 8) return null;
  const rightHigh = Math.max(...rightSide.map((b) => b.high));
  if (rightHigh < leftRim.price * 0.90) return null;

  // Handle: a shallow drift down in the most recent sessions.
  const handle = bars.slice(-15);
  const handleHigh = Math.max(...handle.map((b) => b.high));
  const handleLow = Math.min(...handle.map((b) => b.low));
  const handleDepth = ((handleHigh - handleLow) / handleHigh) * 100;
  const hasHandle = handleDepth >= 2 && handleDepth <= 15;

  const quality = clamp(
    0.35
    + (hasHandle ? 0.25 : 0)
    + clamp(1 - Math.abs(depth - 25) / 30, 0, 1) * 0.25
    + clamp(1 - Math.abs(price - handleHigh) / (handleHigh * 0.08), 0, 1) * 0.15,
    0, 1,
  );

  const breakoutLevel = hasHandle ? handleHigh : leftRim.price;
  return {
    name: hasHandle ? 'Cup with Handle' : 'Cup (no handle yet)',
    direction: 'LONG',
    breakoutLevel,
    target: breakoutLevel + (leftRim.price - bottom),
    invalidation: hasHandle ? handleLow : bottom + (leftRim.price - bottom) * 0.5,
    quality,
    notes: [
      `Cup depth ${depth.toFixed(1)}% over ~${n - leftRim.index} sessions`,
      hasHandle ? `Handle depth ${handleDepth.toFixed(1)}% — constructive shakeout` : 'No handle formed yet; a shallow drift would improve the setup',
    ],
  };
}

function detectDoubleBottom(bars, ph, pl, price) {
  if (pl.length < 2) return null;
  const recent = pl.slice(-6);
  for (let i = recent.length - 1; i >= 1; i--) {
    for (let j = i - 1; j >= 0; j--) {
      const a = recent[j];
      const b = recent[i];
      const gap = b.index - a.index;
      if (gap < 12 || gap > 110) continue;
      const diff = Math.abs(b.price - a.price) / a.price;
      if (diff > 0.06) continue;

      // The middle peak is the neckline / breakout trigger.
      const between = bars.slice(a.index, b.index + 1);
      const peak = Math.max(...between.map((x) => x.high));
      const depth = (peak - Math.min(a.price, b.price)) / peak;
      if (depth < 0.05) continue;

      // O'Neil's variant: the second low undercutting the first is a positive.
      const undercut = b.price < a.price;
      const quality = clamp(0.4 + (undercut ? 0.15 : 0) + (1 - diff / 0.06) * 0.2 + clamp(depth * 2, 0, 0.25), 0, 1);
      return {
        name: 'Double Bottom',
        direction: 'LONG',
        breakoutLevel: peak,
        target: peak + (peak - Math.min(a.price, b.price)),
        invalidation: Math.min(a.price, b.price),
        quality,
        notes: [
          `Two lows at ${a.price.toFixed(2)} and ${b.price.toFixed(2)} (${(diff * 100).toFixed(1)}% apart), ${gap} sessions apart`,
          undercut ? 'Second low undercut the first — a shakeout that clears weak holders' : 'Second low held above the first',
        ],
      };
    }
  }
  return null;
}

function detectHeadAndShoulders(bars, ph, pl, price, variant) {
  const isTop = variant === 'TOP';
  const src = isTop ? ph : pl;
  const opp = isTop ? pl : ph;
  if (src.length < 3 || opp.length < 2) return null;

  const [l, h, r] = src.slice(-3);
  if (!l || !h || !r) return null;

  // Head must be the extreme; shoulders roughly symmetric.
  const headIsExtreme = isTop ? h.price > l.price && h.price > r.price : h.price < l.price && h.price < r.price;
  if (!headIsExtreme) return null;
  const shoulderDiff = Math.abs(l.price - r.price) / ((l.price + r.price) / 2);
  if (shoulderDiff > 0.10) return null;

  // Neckline: the two counter-pivots between the shoulders.
  const necks = opp.filter((p) => p.index > l.index && p.index < r.index).map((p) => p.price);
  if (necks.length < 1) return null;
  const neckline = mean(necks);
  const height = Math.abs(h.price - neckline);
  if (height / price < 0.05) return null;

  const quality = clamp(0.4 + (1 - shoulderDiff / 0.10) * 0.3 + clamp((height / price) * 1.5, 0, 0.25), 0, 1);
  return {
    name: isTop ? 'Head & Shoulders Top' : 'Inverse Head & Shoulders',
    direction: isTop ? 'SHORT' : 'LONG',
    breakoutLevel: neckline,
    target: isTop ? neckline - height : neckline + height,
    invalidation: h.price,
    quality,
    notes: [
      `Shoulders at ${l.price.toFixed(2)} / ${r.price.toFixed(2)} (${(shoulderDiff * 100).toFixed(1)}% asymmetry), head at ${h.price.toFixed(2)}`,
      `Neckline ${neckline.toFixed(2)}; measured move equals the ${height.toFixed(2)} head height`,
    ],
  };
}

/* ------------------------------------------------------------------ *
 * 4. Volume & Order Flow
 * ------------------------------------------------------------------ */

/**
 * Breakouts are only real when institutions are behind them. This agent
 * measures breakout-day volume against the 20-day average, volume behaviour on
 * pullbacks (drying up is bullish), the up/down volume ratio, and a tick-rule
 * order-flow imbalance. It supplies the orchestrator's Volume veto.
 */
export class VolumeOrderFlowAgent extends BaseAgent {
  constructor() {
    super({
      id: 'Volume_OrderFlow_Agent',
      name: 'Volume & Order Flow',
      cluster: CLUSTERS.TECHNICAL,
      description: 'Breakout volume confirmation, pullback dry-up, up/down volume ratio, order-flow imbalance.',
    });
  }

  async analyze(ctx) {
    const bars = ctx.bars;
    const vol = volumes(bars);
    const avg20 = sma(vol, BREAKOUT.volumeLookback);

    // Locate the most recent genuine breakout: a close above the prior 50-day
    // high within the last 15 sessions.
    const priorHigh50 = rollingMax(bars.map((b) => b.high), 50);
    let breakoutIdx = -1;
    for (let i = bars.length - 1; i >= Math.max(51, bars.length - 15); i--) {
      if (priorHigh50[i - 1] != null && bars[i].close > priorHigh50[i - 1]) { breakoutIdx = i; break; }
    }

    const refIdx = breakoutIdx >= 0 ? breakoutIdx : bars.length - 1;
    const volumeRatio = avg20[refIdx] ? vol[refIdx] / avg20[refIdx] : 1;
    const hasBreakout = breakoutIdx >= 0;
    const volumeConfirmed = hasBreakout && volumeRatio >= BREAKOUT.volumeConfirmMultiple;

    // Up/down volume ratio over 50 sessions — accumulation vs distribution.
    const win = bars.slice(-50);
    let upVol = 0;
    let downVol = 0;
    for (let i = 1; i < win.length; i++) {
      if (win[i].close >= win[i - 1].close) upVol += win[i].volume; else downVol += win[i].volume;
    }
    const udRatio = downVol ? upVol / downVol : 2;

    // Pullback dry-up: on down days in the last 10 sessions, is volume light?
    const last10 = bars.slice(-10);
    const downDays = last10.filter((b, i) => i > 0 && b.close < last10[i - 1].close);
    const avgRecent = avg20.at(-1) || mean(vol.slice(-20));
    const pullbackVolRatio = downDays.length ? mean(downDays.map((b) => b.volume)) / avgRecent : 1;
    const dryingUp = pullbackVolRatio < 0.85;

    const ofi = orderFlowImbalance(bars, 20);

    // Weighting depends on whether there is actually a breakout to judge. With
    // no breakout, a quiet session is normal and must not be read as weakness —
    // the signal then comes from accumulation/distribution and order flow.
    const dryUpScore = dryingUp ? 60 : -25;
    let score;
    if (hasBreakout) {
      score = gradeLinear(volumeRatio, 0.8, 2.2) * 0.40
        + gradeLinear(udRatio, 0.7, 1.5) * 0.20
        + dryUpScore * 0.10
        + clamp(ofi * 130, -100, 100) * 0.30;
      if (!volumeConfirmed) score -= 25; // an anemic breakout is a distribution trap
    } else {
      score = gradeLinear(udRatio, 0.7, 1.5) * 0.40
        + dryUpScore * 0.20
        + clamp(ofi * 130, -100, 100) * 0.40;
    }
    score = clamp(score, -100, 100);

    const reasoning = [
      hasBreakout
        ? `Breakout ${bars.length - 1 - breakoutIdx} sessions ago on ${volumeRatio.toFixed(2)}x the 20-day average volume — ${volumeConfirmed ? 'CONFIRMED' : 'ANEMIC, below the 1.5x requirement'}`
        : `No 50-day breakout in the last 15 sessions; latest volume is ${volumeRatio.toFixed(2)}x average`,
      `Up/down volume ratio ${udRatio.toFixed(2)} over 50 sessions — ${udRatio > 1.15 ? 'accumulation' : udRatio < 0.9 ? 'distribution' : 'balanced'}`,
      `Pullback volume ${pullbackVolRatio.toFixed(2)}x average — ${dryingUp ? 'supply is drying up, constructive' : 'sellers still active on down days'}`,
      `Order-flow imbalance ${(ofi * 100).toFixed(1)}% ${ofi > 0 ? 'net buying' : 'net selling'} pressure over 20 sessions`,
    ];

    return {
      score,
      confidence: clamp(0.45 + (hasBreakout ? 0.2 : 0) + Math.min(Math.abs(ofi), 0.3), 0, 0.9),
      reasoning,
      metrics: {
        breakoutDetected: hasBreakout,
        breakoutVolumeRatio: Number(volumeRatio.toFixed(2)),
        volumeConfirmed,
        upDownVolumeRatio: Number(udRatio.toFixed(2)),
        pullbackVolumeRatio: Number(pullbackVolRatio.toFixed(2)),
        orderFlowImbalance: Number(ofi.toFixed(3)),
        buyingPressureIndex: Number(((ofi + 1) / 2).toFixed(3)),
      },
      payload: { hasBreakout, volumeRatio, volumeConfirmed, orderFlowImbalance: ofi },
    };
  }
}

/* ------------------------------------------------------------------ *
 * 5. Relative Strength
 * ------------------------------------------------------------------ */

/**
 * Mansfield Relative Strength plus an IBD-style 1-99 RS rating. Leadership is
 * the single most persistent edge in the O'Neil / Weinstein framework: only
 * names above the 80th percentile qualify as leaders.
 */
export class RelativeStrengthAgent extends BaseAgent {
  constructor() {
    super({
      id: 'Relative_Strength_Agent',
      name: 'Momentum & Relative Strength',
      cluster: CLUSTERS.TECHNICAL,
      description: 'Mansfield RS vs QQQ, 1-99 RS rating, RS-line new highs, MACD/RSI momentum state.',
    });
  }

  async analyze(ctx) {
    const bars = ctx.bars;
    const bench = ctx.benchmarkBars;
    const n = Math.min(bars.length, bench.length);
    if (n < 260) throw new Error('need at least one year of history for RS');

    const s = closes(bars).slice(-n);
    const b = closes(bench).slice(-n);

    // RS line = stock / benchmark. Mansfield normalises it by its own 52-week
    // average so the zero line separates leaders from laggards.
    const rsLine = s.map((v, i) => v / b[i]);
    const rsMa = sma(rsLine, 252);
    const mansfield = rsMa.at(-1) ? (rsLine.at(-1) / rsMa.at(-1) - 1) * 100 : 0;

    // RS line at a new high while price consolidates is the classic tell.
    const rsHigh63 = Math.max(...rsLine.slice(-63));
    const rsAtNewHigh = rsLine.at(-1) >= rsHigh63 * 0.999;

    // IBD-style weighted relative performance: recent quarter double-weighted.
    const rp = (k) => (s.at(-1) / s.at(-1 - k) - 1) - (b.at(-1) / b.at(-1 - k) - 1);
    const weighted = 0.4 * rp(63) + 0.2 * rp(126) + 0.2 * rp(189) + 0.2 * rp(252);

    // Map onto 1-99 through a normal CDF with dispersion calibrated to a typical
    // large-cap tech cross-section (sigma ~ 22% annual relative return).
    const rsRating = clamp(Math.round(normalCdf(weighted / 0.22) * 98) + 1, 1, 99);

    const m = macd(s);
    const r = rsi(s, 14);
    const macdHist = m.hist.at(-1) ?? 0;
    const macdRising = (m.hist.at(-1) ?? 0) > (m.hist.at(-5) ?? 0);
    const rsiNow = r.at(-1) ?? 50;

    // Bearish divergence: price makes a higher high, RSI does not.
    const priceHigherHigh = s.at(-1) > Math.max(...s.slice(-40, -1));
    const rsiHigherHigh = rsiNow > Math.max(...r.slice(-40, -1).filter((x) => x != null));
    const bearishDivergence = priceHigherHigh && !rsiHigherHigh;

    const momentumState = macdRising && rsiNow > 50 ? 'ACCELERATING'
      : bearishDivergence || (rsiNow > 78 && !macdRising) ? 'EXHAUSTED'
        : rsiNow < 40 ? 'WEAKENING' : 'STEADY';

    let score = gradeLinear(rsRating, 30, 90) * 0.5
      + clamp(mansfield * 3, -30, 30) * 0.25
      + (rsAtNewHigh ? 18 : -5)
      + (macdRising ? 10 : -10);
    if (bearishDivergence) score -= 18;
    score = clamp(score, -100, 100);

    const reasoning = [
      `RS Rating ${rsRating}/99 — ${rsRating >= 80 ? 'market leader' : rsRating >= 60 ? 'above average' : 'laggard, fails the leadership screen'}`,
      `Mansfield RS ${mansfield >= 0 ? '+' : ''}${mansfield.toFixed(2)} (${mansfield > 0 ? 'outperforming' : 'underperforming'} the benchmark trend)`,
      rsAtNewHigh ? 'RS line at a 3-month high — relative leadership confirmed' : 'RS line below its recent high',
      `Momentum ${momentumState}: RSI(14) ${rsiNow.toFixed(1)}, MACD histogram ${macdHist >= 0 ? '+' : ''}${macdHist.toFixed(3)} and ${macdRising ? 'rising' : 'falling'}`,
    ];
    if (bearishDivergence) reasoning.push('Bearish RSI divergence: price made a higher high without momentum confirmation');

    return {
      score,
      confidence: clamp(0.45 + Math.abs(rsRating - 50) / 120, 0, 0.92),
      reasoning,
      metrics: {
        rsRating,
        mansfieldRS: Number(mansfield.toFixed(2)),
        rsLineAtNewHigh: rsAtNewHigh,
        rsi14: Number(rsiNow.toFixed(1)),
        macdHistogram: Number(macdHist.toFixed(4)),
        momentumState,
        bearishDivergence,
        relPerf3m: Number((rp(63) * 100).toFixed(1)),
        relPerf12m: Number((rp(252) * 100).toFixed(1)),
      },
      payload: { rsRating, mansfield, momentumState, isLeader: rsRating >= 80 },
    };
  }
}

/** Abramowitz & Stegun 7.1.26 normal CDF approximation. */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
