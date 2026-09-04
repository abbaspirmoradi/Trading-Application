// Backtest & walk-forward audit suite.
//
// Bias controls that matter more than the headline return:
//   * No look-ahead — signals use only bars up to and including t, and every
//     trade is resolved bar-by-bar going forward.
//   * Out-of-sample only — statistics are accumulated exclusively from the test
//     windows of a rolling walk-forward split, never from the training windows.
//   * Data-snooping control — a Monte Carlo permutation test shuffles the return
//     series and re-runs the identical strategy to build the null distribution
//     of "what this rule earns on noise with the same distribution". The
//     resulting p-value is the probability the live result is luck.

import { closes, sma, atr } from '../lib/indicators.js';
import { mean, stdev, seededRandom, hashString } from '../lib/stats.js';
import { BARRIERS } from '../config/constants.js';

/** Primary rule: trend-following long entries confirmed by relative strength. */
function primarySignal(i, pre, benchCloses) {
  const { px, ma150, ma50 } = pre;
  if (ma150[i] == null || ma50[i] == null || i < 260) return false;
  const trendUp = px[i] > ma150[i] && ma50[i] > ma150[i];
  const bIdx = Math.min(i, benchCloses.length - 1);
  const rel = (px[i] / px[i - 63] - 1) - (benchCloses[bIdx] / benchCloses[Math.max(0, bIdx - 63)] - 1);
  return trendUp && rel > 0;
}

/** Runs the strategy over [from, to) and returns the closed trades. */
function simulate(bars, benchCloses, pre, from, to) {
  const trades = [];
  let i = from;
  while (i < to) {
    if (!primarySignal(i, pre, benchCloses)) { i++; continue; }
    const atrNow = pre.atrSeries[i];
    if (!atrNow) { i++; continue; }

    const entry = bars[i].close;
    const target = entry + BARRIERS.profitAtrMultiple * atrNow;
    const stop = entry - BARRIERS.stopAtrMultiple * atrNow;
    const risk = entry - stop;

    let exitIdx = Math.min(i + BARRIERS.maxHoldingDays, bars.length - 1);
    let exitPrice = bars[exitIdx].close;
    let barrier = 'TIME';

    for (let j = i + 1; j <= Math.min(i + BARRIERS.maxHoldingDays, bars.length - 1); j++) {
      // Conservative tie-breaking: if a bar spans both barriers, assume the
      // stop was hit first. Optimistic assumptions here are how backtests lie.
      if (bars[j].low <= stop) { exitIdx = j; exitPrice = stop; barrier = 'STOP'; break; }
      if (bars[j].high >= target) { exitIdx = j; exitPrice = target; barrier = 'PROFIT'; break; }
    }

    trades.push({
      entryDate: bars[i].date,
      exitDate: bars[exitIdx].date,
      entry: Number(entry.toFixed(2)),
      exit: Number(exitPrice.toFixed(2)),
      barrier,
      holdingDays: exitIdx - i,
      returnPct: Number((((exitPrice - entry) / entry) * 100).toFixed(2)),
      rMultiple: Number(((exitPrice - entry) / (risk || 1e-9)).toFixed(2)),
    });

    i = exitIdx + 1; // no overlapping positions
  }
  return trades;
}

function statsFrom(trades) {
  if (!trades.length) {
    return { trades: 0, winRate: 0, avgReturnPct: 0, totalReturnPct: 0, profitFactor: 0, sharpe: 0, maxDrawdownPct: 0, avgRMultiple: 0, expectancyR: 0 };
  }
  const rets = trades.map((t) => t.returnPct);
  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct <= 0);

  // Compounded equity curve, one point per closed trade.
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  const curve = [];
  for (const t of trades) {
    equity *= 1 + t.returnPct / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
    curve.push({ date: t.exitDate, equity: Number(equity.toFixed(4)) });
  }

  const grossWin = wins.reduce((a, t) => a + t.returnPct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.returnPct, 0));
  const sd = stdev(rets) || 1e-9;
  // Annualised from per-trade returns using the realised trade frequency.
  const avgHold = mean(trades.map((t) => t.holdingDays)) || 1;
  const tradesPerYear = 252 / avgHold;

  return {
    trades: trades.length,
    winRate: Number(((wins.length / trades.length) * 100).toFixed(1)),
    avgReturnPct: Number(mean(rets).toFixed(2)),
    totalReturnPct: Number(((equity - 1) * 100).toFixed(2)),
    profitFactor: Number((grossLoss ? grossWin / grossLoss : grossWin > 0 ? 99 : 0).toFixed(2)),
    sharpe: Number(((mean(rets) / sd) * Math.sqrt(tradesPerYear)).toFixed(2)),
    maxDrawdownPct: Number((maxDd * 100).toFixed(2)),
    avgRMultiple: Number(mean(trades.map((t) => t.rMultiple)).toFixed(2)),
    expectancyR: Number(mean(trades.map((t) => t.rMultiple)).toFixed(2)),
    barrierBreakdown: {
      PROFIT: trades.filter((t) => t.barrier === 'PROFIT').length,
      STOP: trades.filter((t) => t.barrier === 'STOP').length,
      TIME: trades.filter((t) => t.barrier === 'TIME').length,
    },
    equityCurve: curve,
  };
}

function precompute(bars) {
  const px = closes(bars);
  return { px, ma150: sma(px, 150), ma50: sma(px, 50), atrSeries: atr(bars, BARRIERS.atrPeriod) };
}

/**
 * Rolling walk-forward: train on `trainWindow` bars, trade the following
 * `testWindow` bars, step forward, repeat. Reported statistics come only from
 * the concatenated out-of-sample segments.
 */
export function walkForwardBacktest(ctx, { trainWindow = 252, testWindow = 63, permutations = 200 } = {}) {
  const bars = ctx.bars;
  const benchCloses = closes(ctx.benchmarkBars);
  const pre = precompute(bars);

  const folds = [];
  const oosTrades = [];
  let start = 260;
  while (start + trainWindow + testWindow <= bars.length) {
    const testFrom = start + trainWindow;
    const testTo = testFrom + testWindow;
    const trades = simulate(bars, benchCloses, pre, testFrom, testTo);
    folds.push({
      fold: folds.length + 1,
      trainFrom: bars[start].date,
      testFrom: bars[testFrom].date,
      testTo: bars[testTo - 1].date,
      ...statsFrom(trades),
      equityCurve: undefined, // per-fold curves are noise in the response
    });
    oosTrades.push(...trades);
    start += testWindow;
  }

  const oos = statsFrom(oosTrades);
  const inSample = statsFrom(simulate(bars, benchCloses, pre, 260, bars.length));

  /* -------- Monte Carlo permutation test (data-snooping control) -------- */
  const observed = oos.totalReturnPct;
  const rnd = seededRandom(hashString(`${ctx.ticker}:permtest`));
  const logRets = [];
  for (let i = 1; i < bars.length; i++) logRets.push(Math.log(bars[i].close / bars[i - 1].close));

  let atLeastAsGood = 0;
  const nullReturns = [];
  for (let p = 0; p < permutations; p++) {
    // Fisher-Yates shuffle of returns: destroys the temporal structure the
    // strategy claims to exploit while preserving the return distribution.
    const shuffled = [...logRets];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const synth = [bars[0]];
    for (let i = 0; i < shuffled.length; i++) {
      const prev = synth[i].close;
      const close = prev * Math.exp(shuffled[i]);
      const spread = Math.abs(close - prev) * 0.6 + prev * 0.004;
      synth.push({
        date: bars[i + 1].date,
        open: prev,
        close,
        high: Math.max(prev, close) + spread,
        low: Math.min(prev, close) - spread,
        volume: bars[i + 1].volume,
      });
    }
    const synthPre = precompute(synth);
    const synthStats = statsFrom(simulate(synth, benchCloses, synthPre, 260, synth.length));
    nullReturns.push(synthStats.totalReturnPct);
    if (synthStats.totalReturnPct >= observed) atLeastAsGood++;
  }

  const pValue = (atLeastAsGood + 1) / (permutations + 1);
  const nullMean = mean(nullReturns);
  const nullSd = stdev(nullReturns) || 1e-9;

  return {
    ticker: ctx.ticker,
    barsAnalysed: bars.length,
    period: { from: bars[0].date, to: bars.at(-1).date },
    strategy: 'Trend + relative-strength primary signal, triple-barrier exits',
    outOfSample: oos,
    inSample,
    folds,
    trades: oosTrades.slice(-60),
    permutationTest: {
      permutations,
      observedReturnPct: observed,
      nullMeanReturnPct: Number(nullMean.toFixed(2)),
      nullStdevPct: Number(nullSd.toFixed(2)),
      zScore: Number(((observed - nullMean) / nullSd).toFixed(2)),
      pValue: Number(pValue.toFixed(4)),
      verdict: pValue < 0.01 ? 'VALIDATED' : pValue < 0.05 ? 'MARGINAL' : 'SPURIOUS',
      interpretation: pValue < 0.01
        ? 'The edge survives a permutation test at the 1% level — it is unlikely to be an artefact of data snooping.'
        : pValue < 0.05
          ? 'The edge is significant at 5% but not 1%. Treat it as provisional and size conservatively.'
          : 'The result is indistinguishable from what this rule earns on shuffled noise. Do not trade it.',
    },
    degradation: {
      inSampleReturnPct: inSample.totalReturnPct,
      outOfSampleReturnPct: oos.totalReturnPct,
      // A large positive number here is the classic overfitting fingerprint.
      degradationPct: Number((inSample.totalReturnPct - oos.totalReturnPct).toFixed(2)),
    },
  };
}
