import { BaseAgent, gradeLinear } from './BaseAgent.js';
import { CLUSTERS } from '../config/constants.js';
import { closes, sma } from '../lib/indicators.js';
import { clamp } from '../lib/stats.js';

/**
 * CAN SLIM (O'Neil). Each of the seven letters is graded independently on a
 * -100..+100 scale and then weighted, so the reasoning trace can show exactly
 * which letters carried or sank the name.
 */
export class CanSlimAgent extends BaseAgent {
  constructor() {
    super({
      id: 'CAN_SLIM_Agent',
      name: 'CAN SLIM Growth',
      cluster: CLUSTERS.FUNDAMENTAL,
      description: 'Quarterly & annual earnings acceleration, new catalyst, float/supply, leadership, institutional sponsorship, market direction.',
    });
  }

  async analyze(ctx) {
    const f = ctx.fundamentals;
    const px = closes(ctx.bars);
    const price = ctx.price;
    const reasoning = [];

    // C — Current quarterly EPS growth. 25% is the floor, 50%+ is the target.
    const cScore = gradeLinear(f.epsGrowthQoQ, 0, 50);
    reasoning.push(`C: Quarterly EPS growth ${f.epsGrowthQoQ}% YoY ${f.epsGrowthQoQ >= 25 ? '— clears the 25% threshold' : '— below the 25% threshold'}`);

    // Acceleration matters as much as level.
    const accelerating = f.epsGrowthQoQ > f.epsGrowthPrevQ;
    if (accelerating) reasoning.push(`C: Earnings accelerating (${f.epsGrowthPrevQ}% -> ${f.epsGrowthQoQ}%)`);

    // A — Annual earnings growth over 3 years.
    const aScore = gradeLinear(f.annualEpsGrowth3y, 0, 30);
    reasoning.push(`A: 3-year annual EPS growth ${f.annualEpsGrowth3y}%, ROE ${f.roe}%`);

    // N — New product/management catalyst AND price near new highs.
    const high52 = Math.max(...px.slice(-252));
    const pctOffHigh = ((high52 - price) / high52) * 100;
    const nScore = clamp((f.hasNewCatalyst ? 45 : -15) + gradeLinear(-pctOffHigh, -25, -2) * 0.6, -100, 100);
    reasoning.push(`N: ${f.catalystNote}; price is ${pctOffHigh.toFixed(1)}% off its 52-week high`);

    // S — Supply. A tight float moves further on the same demand.
    const sScore = gradeLinear(-f.floatM, -1500, -150);
    reasoning.push(`S: Float ${f.floatM}M shares of ${f.sharesOutstandingM}M outstanding ${f.floatM < 600 ? '— tight supply' : '— heavy supply'}`);

    // L — Leader not laggard: 6-month performance vs the benchmark.
    const rs6m = relativePerf(ctx.bars, ctx.benchmarkBars, 126);
    const lScore = gradeLinear(rs6m, -15, 25);
    reasoning.push(`L: 6-month relative performance vs ${'QQQ'} is ${rs6m > 0 ? '+' : ''}${rs6m.toFixed(1)}%`);

    // I — Institutional sponsorship should be rising, not merely present.
    const iScore = gradeLinear(f.instHoldersQoQChange, -5, 10);
    reasoning.push(`I: Institutional holders ${f.instHoldersQoQChange > 0 ? 'up' : 'down'} ${Math.abs(f.instHoldersQoQChange)}% QoQ (${f.instOwnershipPct}% held)`);

    // M — Market direction: three out of four O'Neil trades fail against the tape.
    const benchCloses = closes(ctx.benchmarkBars);
    const bench200 = sma(benchCloses, 200).at(-1);
    const marketUp = bench200 != null && benchCloses.at(-1) > bench200;
    const mScore = marketUp ? 55 : -55;
    reasoning.push(`M: Benchmark is ${marketUp ? 'above' : 'below'} its 200-day average — market direction is ${marketUp ? 'supportive' : 'hostile'}`);

    const weights = { C: 0.22, A: 0.15, N: 0.14, S: 0.08, L: 0.18, I: 0.11, M: 0.12 };
    const parts = { C: cScore, A: aScore, N: nScore, S: sScore, L: lScore, I: iScore, M: mScore };
    let score = Object.entries(weights).reduce((acc, [k, w]) => acc + parts[k] * w, 0);
    if (accelerating) score += 5;

    // Confidence tracks agreement across the letters — a split verdict is a
    // weak verdict even when the weighted average looks decisive.
    const vals = Object.values(parts);
    const agree = vals.filter((v) => Math.sign(v) === Math.sign(score)).length / vals.length;
    const confidence = clamp(0.35 + agree * 0.5, 0, 0.95);

    return {
      score,
      confidence,
      reasoning,
      metrics: {
        epsGrowthQoQ: f.epsGrowthQoQ,
        salesGrowthQoQ: f.salesGrowthQoQ,
        annualEpsGrowth3y: f.annualEpsGrowth3y,
        floatM: f.floatM,
        pctOffHigh52w: Number(pctOffHigh.toFixed(1)),
        instHoldersQoQChange: f.instHoldersQoQChange,
        marketDirectionSupportive: marketUp,
        letterScores: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Number(v.toFixed(1))])),
      },
      payload: { canSlimPass: score > 30, marketDirectionSupportive: marketUp },
    };
  }
}

function relativePerf(bars, benchBars, lookback) {
  if (bars.length <= lookback || benchBars.length <= lookback) return 0;
  const stock = (bars.at(-1).close / bars.at(-1 - lookback).close - 1) * 100;
  const bench = (benchBars.at(-1).close / benchBars.at(-1 - lookback).close - 1) * 100;
  return stock - bench;
}

export { relativePerf };
