// Pooled cross-sectional backtest.
//
// Replaces the per-ticker test, which was the single worst methodological error
// in the original build: ~6 trades per name cannot distinguish skill from noise
// in EITHER direction, so "not significant" was as much a statement about the
// test's power as about the strategy. Pooling the universe turns dozens of
// underpowered tests into one adequately powered one.
//
// Three additions the per-ticker version lacked:
//
//   1. A BUY-AND-HOLD BENCHMARK. For a position trader the alternative to any
//      strategy is simply owning the asset. A rule that returns 40% while
//      buy-and-hold returns 300% has negative value, however good 40% looks
//      alone. Absolute return is close to meaningless without this.
//   2. TIME-SERIES SPLITS with an embargo, so a trade open across a split
//      boundary cannot leak information from test into train.
//   3. A BOOTSTRAP CONFIDENCE INTERVAL on expectancy, resampling by TICKER
//      rather than by trade — trades within one name are not independent.
//
// It cannot fix survivorship bias: the universe is today's large caps, which by
// construction survived and grew. Every absolute number here is flattered by
// that, which is precisely why the benchmark comparison is the headline.

import { closes, sma, atr } from '../lib/indicators.js';
import { mean, stdev, seededRandom, hashString } from '../lib/stats.js';
import { BARRIERS } from '../config/constants.js';
import { getFullHistory } from '../data/marketDataService.js';
import { mapLimit } from '../lib/concurrency.js';

/** Primary rule: trend-following, confirmed by relative strength. */
function signalAt(i, pre, benchCloses, benchIndexFor) {
  const { px, maSlow, maFast } = pre;
  if (i < 260 || maSlow[i] == null || maFast[i] == null) return false;
  if (!(px[i] > maSlow[i] && maFast[i] > maSlow[i])) return false;

  const bi = benchIndexFor(i);
  if (bi == null || bi < 126) return false;
  const stock = px[i] / px[i - 126] - 1;
  const bench = benchCloses[bi] / benchCloses[bi - 126] - 1;
  return stock - bench > 0;
}

function precompute(bars) {
  const px = closes(bars);
  return {
    px,
    maSlow: sma(px, 200),
    maFast: sma(px, 50),
    // 150 trading days ~ the 30-week average Weinstein trails behind a Stage 2.
    maTrail: sma(px, 150),
    atrSeries: atr(bars, BARRIERS.atrPeriod),
  };
}

/**
 * Exit policies.
 *
 *   FIXED_BARRIER — the original triple barrier: fixed target, fixed stop, time
 *                   limit. Appropriate for swing horizons.
 *   STAGE_TRAIL   — Weinstein's position exit: no upper barrier at all. Hold
 *                   while the trend holds, exit on a weekly close below the
 *                   30-week average or on a hard stop. A fixed target is
 *                   actively harmful over years, because it caps exactly the
 *                   handful of positions that pay for everything else.
 */
export const EXIT_POLICIES = { FIXED_BARRIER: 'FIXED_BARRIER', STAGE_TRAIL: 'STAGE_TRAIL' };

/** Simulates the rule over [from, to), returning closed trades. */
function simulate(bars, pre, benchCloses, benchIndexFor, from, to, policy = EXIT_POLICIES.FIXED_BARRIER, confirmDays = 5, trailBufferPct = 0) {
  const trades = [];
  let i = Math.max(from, 260);
  while (i < to) {
    if (!signalAt(i, pre, benchCloses, benchIndexFor)) { i++; continue; }
    const atrNow = pre.atrSeries[i];
    if (!atrNow) { i++; continue; }

    const entry = bars[i].close;
    const stop = entry - BARRIERS.stopAtrMultiple * atrNow;
    const trailing = policy === EXIT_POLICIES.STAGE_TRAIL;

    // The trailing policy has no upper barrier and no fixed calendar limit; it
    // rides the trend until the trend itself ends.
    const target = trailing ? Infinity : entry + BARRIERS.profitAtrMultiple * atrNow;
    const horizonEnd = trailing
      ? bars.length - 1
      : Math.min(i + BARRIERS.maxHoldingDays, bars.length - 1);

    let exitIdx = horizonEnd;
    let exitPrice = bars[horizonEnd].close;
    let barrier = 'TIME';
    let consecutiveBelow = 0;
    for (let j = i + 1; j <= horizonEnd; j++) {
      // A bar spanning both barriers is scored as the stop: optimistic
      // tie-breaking is how backtests flatter themselves.
      if (bars[j].low <= stop) { exitIdx = j; exitPrice = stop; barrier = 'STOP'; break; }
      if (!trailing && bars[j].high >= target) { exitIdx = j; exitPrice = target; barrier = 'PROFIT'; break; }
      // Trend break. Weinstein trails a WEEKLY close beneath the 30-week
      // average; testing a daily close against it ejects the position on every
      // one-day dip, which is what made the first attempt exit 2368 times and
      // halve the average hold. Requiring `confirmDays` consecutive closes
      // below approximates the weekly rule and filters single-bar whipsaws.
      if (trailing && pre.maTrail[j] != null) {
        const below = bars[j].close < pre.maTrail[j] * (1 - trailBufferPct / 100);
        consecutiveBelow = below ? consecutiveBelow + 1 : 0;
        if (consecutiveBelow >= confirmDays) {
          exitIdx = j; exitPrice = bars[j].close; barrier = 'TREND_BREAK'; break;
        }
      }
    }

    // Benchmark held over the identical window — the true opportunity cost.
    const bEntry = benchIndexFor(i);
    const bExit = benchIndexFor(exitIdx);
    const benchReturnPct = (bEntry != null && bExit != null && benchCloses[bEntry])
      ? (benchCloses[bExit] / benchCloses[bEntry] - 1) * 100
      : null;

    const returnPct = ((exitPrice - entry) / entry) * 100;
    trades.push({
      entryIndex: i,
      exitIndex: exitIdx,
      entryDate: bars[i].date,
      exitDate: bars[exitIdx].date,
      barrier,
      holdingDays: exitIdx - i,
      returnPct: Number(returnPct.toFixed(3)),
      benchReturnPct: benchReturnPct == null ? null : Number(benchReturnPct.toFixed(3)),
      excessPct: benchReturnPct == null ? null : Number((returnPct - benchReturnPct).toFixed(3)),
      rMultiple: Number(((exitPrice - entry) / (entry - stop)).toFixed(3)),
    });

    i = exitIdx + 1; // no overlapping positions in one name
  }
  return trades;
}

function summarise(trades) {
  if (!trades.length) return { trades: 0 };
  const rets = trades.map((t) => t.returnPct);
  const exc = trades.map((t) => t.excessPct).filter((x) => x != null);
  const wins = trades.filter((t) => t.returnPct > 0);
  const grossWin = wins.reduce((a, t) => a + t.returnPct, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.returnPct <= 0).reduce((a, t) => a + t.returnPct, 0));
  const avgHold = mean(trades.map((t) => t.holdingDays)) || 1;

  return {
    trades: trades.length,
    winRatePct: Number(((wins.length / trades.length) * 100).toFixed(1)),
    meanReturnPct: Number(mean(rets).toFixed(2)),
    medianReturnPct: Number([...rets].sort((a, b) => a - b)[Math.floor(rets.length / 2)].toFixed(2)),
    meanExcessVsBuyHoldPct: exc.length ? Number(mean(exc).toFixed(2)) : null,
    beatBenchmarkPct: exc.length ? Number(((exc.filter((x) => x > 0).length / exc.length) * 100).toFixed(1)) : null,
    profitFactor: Number((grossLoss ? grossWin / grossLoss : 99).toFixed(2)),
    meanRMultiple: Number(mean(trades.map((t) => t.rMultiple)).toFixed(2)),
    avgHoldingDays: Math.round(avgHold),
    barriers: {
      PROFIT: trades.filter((t) => t.barrier === 'PROFIT').length,
      STOP: trades.filter((t) => t.barrier === 'STOP').length,
      TIME: trades.filter((t) => t.barrier === 'TIME').length,
      TREND_BREAK: trades.filter((t) => t.barrier === 'TREND_BREAK').length,
    },
  };
}

/**
 * Bootstrap CI for mean excess return, resampling whole TICKERS. Trades within
 * one name share a regime and are not independent, so resampling individual
 * trades would understate the interval badly.
 */
function bootstrapByTicker(byTicker, iterations = 2000, seed = 12345) {
  const names = Object.keys(byTicker).filter((k) => byTicker[k].length);
  if (names.length < 3) return null;
  const rnd = seededRandom(seed);
  const means = [];

  for (let b = 0; b < iterations; b++) {
    const pooled = [];
    for (let k = 0; k < names.length; k++) {
      const pick = names[Math.floor(rnd() * names.length)];
      for (const t of byTicker[pick]) if (t.excessPct != null) pooled.push(t.excessPct);
    }
    if (pooled.length) means.push(mean(pooled));
  }
  means.sort((a, b) => a - b);
  const q = (p) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * means.length)))];
  return {
    meanExcessPct: Number(mean(means).toFixed(3)),
    ci95Low: Number(q(0.025).toFixed(3)),
    ci95High: Number(q(0.975).toFixed(3)),
    // The interval straddling zero is the plain-language verdict.
    excludesZero: q(0.025) > 0 || q(0.975) < 0,
  };
}

export async function pooledBacktest({
  universe,
  embargoDays = BARRIERS.maxHoldingDays,
  concurrency = 5,
  bootstrapIterations = 2000,
  exitPolicy = EXIT_POLICIES.FIXED_BARRIER,
  confirmDays = 5,
  trailBufferPct = 0,
} = {}) {
  const startedAt = Date.now();

  const benchBars = await getFullHistory('QQQ');
  const benchCloses = closes(benchBars);
  const benchDateIndex = new Map(benchBars.map((b, i) => [b.date, i]));

  const per = await mapLimit(universe, concurrency, async (ticker) => {
    const bars = await getFullHistory(ticker);
    if (bars.length < 600) return { ticker, skipped: `only ${bars.length} bars` };
    const pre = precompute(bars);
    const benchIndexFor = (i) => benchDateIndex.get(bars[i]?.date) ?? null;

    // Embargo the tail so no trade can still be open at the end of the sample.
    const usableTo = bars.length - embargoDays;
    const trades = simulate(bars, pre, benchCloses, benchIndexFor, 260, usableTo, exitPolicy, confirmDays, trailBufferPct);

    // Buy-and-hold over the identical usable window, for the same capital.
    const bhFrom = 260;
    const bhTo = usableTo - 1;
    const buyHoldPct = bhTo > bhFrom
      ? (pre.px[bhTo] / pre.px[bhFrom] - 1) * 100
      : null;

    // Compounded strategy return, so it is comparable with buy-and-hold.
    let equity = 1;
    for (const t of trades) equity *= 1 + t.returnPct / 100;
    const strategyCompoundedPct = (equity - 1) * 100;

    return {
      ticker,
      trades,
      firstDate: bars[bhFrom].date,
      lastDate: bars[bhTo].date,
      buyHoldPct: buyHoldPct == null ? null : Number(buyHoldPct.toFixed(1)),
      strategyCompoundedPct: Number(strategyCompoundedPct.toFixed(1)),
      timeInMarketPct: Number(((trades.reduce((a, t) => a + t.holdingDays, 0) / (bhTo - bhFrom)) * 100).toFixed(1)),
    };
  });

  const ok = per.filter((r) => r && r.trades && !r.error);
  const skipped = per.filter((r) => r && (r.skipped || r.error));

  const allTrades = ok.flatMap((r) => r.trades);
  const byTicker = Object.fromEntries(ok.map((r) => [r.ticker, r.trades]));

  const pooled = summarise(allTrades);
  const boot = bootstrapByTicker(byTicker, bootstrapIterations);

  // Head-to-head against simply owning each name for the whole period.
  const comparable = ok.filter((r) => r.buyHoldPct != null);
  const beat = comparable.filter((r) => r.strategyCompoundedPct > r.buyHoldPct).length;

  return {
    generatedAt: new Date().toISOString(),
    horizon: BARRIERS.horizon,
    horizonLabel: BARRIERS.label,
    exitPolicy,
    exitTuning: exitPolicy === EXIT_POLICIES.STAGE_TRAIL ? { confirmDays, trailBufferPct } : null,
    config: {
      profitAtrMultiple: BARRIERS.profitAtrMultiple,
      stopAtrMultiple: BARRIERS.stopAtrMultiple,
      maxHoldingDays: BARRIERS.maxHoldingDays,
      embargoDays,
    },
    universeSize: universe.length,
    tickersTested: ok.length,
    skipped: skipped.map((s) => ({ ticker: s.ticker, reason: s.skipped || s.error })),
    period: ok.length ? { from: ok[0].firstDate, to: ok[0].lastDate } : null,
    pooled,
    bootstrap: boot,
    versusBuyAndHold: {
      tickersWhereStrategyWon: beat,
      tickersCompared: comparable.length,
      winRatePct: comparable.length ? Number(((beat / comparable.length) * 100).toFixed(1)) : null,
      medianStrategyPct: median(comparable.map((r) => r.strategyCompoundedPct)),
      medianBuyHoldPct: median(comparable.map((r) => r.buyHoldPct)),
      meanTimeInMarketPct: Number(mean(comparable.map((r) => r.timeInMarketPct)).toFixed(1)),
    },
    perTicker: ok.map((r) => ({
      ticker: r.ticker,
      trades: r.trades.length,
      strategyPct: r.strategyCompoundedPct,
      buyHoldPct: r.buyHoldPct,
      timeInMarketPct: r.timeInMarketPct,
    })),
    caveats: [
      'SURVIVORSHIP BIAS: the universe is today\'s large caps, which by construction survived and grew. Absolute returns are flattered; the buy-and-hold comparison is the number that matters because both sides carry the same bias.',
      'No transaction costs, slippage, spreads, taxes or dividends are modelled.',
      'Signals use only bars up to and including the entry day; a bar touching both barriers is scored as the stop.',
      'The bootstrap resamples whole tickers, not individual trades, because trades within one name share a regime.',
    ],
    elapsedMs: Date.now() - startedAt,
  };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.floor(s.length / 2)].toFixed(1));
}
