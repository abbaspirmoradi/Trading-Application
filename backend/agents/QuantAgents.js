import { BaseAgent } from './BaseAgent.js';
import { CLUSTERS } from '../config/constants.js';
import { closes, fracDiff, adfTest, dollarBars, orderFlowImbalance } from '../lib/indicators.js';
import { mean, stdev, correlation, clamp, adfPValue } from '../lib/stats.js';

/* ------------------------------------------------------------------ *
 * 6. Fractional Differentiation & Structural Quant
 * ------------------------------------------------------------------ */

/**
 * López de Prado's core insight: raw prices carry memory but are
 * non-stationary; integer differencing (returns) is stationary but erases all
 * memory. Fractional differentiation finds the *minimum* d that passes an ADF
 * test, keeping as much memory as statistical validity allows.
 *
 * The agent then reads the resulting stationary series two ways — as a
 * trend/drift measure and as a mean-reversion z-score — and additionally
 * samples dollar bars to check whether activity is buy- or sell-imbalanced.
 */
export class FractionalQuantAgent extends BaseAgent {
  constructor() {
    super({
      id: 'Fractional_Quant_Agent',
      name: 'Fractional Differentiation & Stationarity',
      cluster: CLUSTERS.QUANT,
      description: 'Minimum-d fractional differentiation, ADF stationarity, dollar-bar imbalance, mean-reversion z-score.',
    });
  }

  async analyze(ctx) {
    const px = closes(ctx.bars);
    if (px.length < 200) throw new Error('insufficient history for fractional differentiation');

    // Work in log space — the standard domain for fracdiff on prices.
    const logPx = px.map((p) => Math.log(p));

    // Sweep d upward and stop at the first order that achieves stationarity:
    // that is the memory-preserving optimum.
    const sweep = [];
    let optimal = null;
    for (let d = 0.05; d <= 1.0001; d += 0.05) {
      const dr = Number(d.toFixed(2));
      const { series } = fracDiff(logPx, dr, 1e-4, 180);
      if (series.length < 80) { sweep.push({ d: dr, adfT: null, pValue: null, memory: null }); continue; }
      const { tStat, usable } = adfTest(series, 1);
      const pValue = usable ? adfPValue(tStat) : 1;
      // Memory retained = correlation with the original level series.
      const memory = Math.abs(correlation(series, logPx.slice(-series.length)));
      sweep.push({ d: dr, adfT: Number(tStat.toFixed(2)), pValue: Number(pValue.toFixed(3)), memory: Number(memory.toFixed(3)) });
      if (!optimal && usable && pValue < 0.05) optimal = { d: dr, tStat, pValue, memory, series };
    }

    const chosen = optimal ?? (() => {
      const { series } = fracDiff(logPx, 1.0, 1e-4, 180);
      const { tStat } = adfTest(series, 1);
      return { d: 1.0, tStat, pValue: adfPValue(tStat), memory: Math.abs(correlation(series, logPx.slice(-series.length))), series };
    })();

    const fd = chosen.series;
    const m = mean(fd);
    const sd = stdev(fd) || 1e-9;
    const z = (fd.at(-1) - m) / sd;

    // Drift = how far the recent regime sits from the series' own long-run mean,
    // in sigmas. Measured against the mean, not the raw level: for d < 1 the
    // fracdiff weights do not sum to zero, so the series carries a large
    // non-zero level that would otherwise swamp the signal.
    const recentDrift = (mean(fd.slice(-63)) - m) / sd;

    // Dollar bars: sample by traded value rather than by clock time.
    const avgDollar = mean(ctx.bars.slice(-60).map((b) => b.close * b.volume));
    const dBars = dollarBars(ctx.bars.slice(-250), avgDollar * 3);
    const dbImbalance = dBars.length > 10 ? orderFlowImbalance(dBars, Math.min(20, dBars.length - 1)) : 0;
    const imbalanceState = dbImbalance > 0.15 ? 'BUY_IMBALANCE' : dbImbalance < -0.15 ? 'SELL_IMBALANCE' : 'BALANCED';

    // Trend persistence dominates; an extreme z-score flags exhaustion and
    // pulls the score back toward neutral (or negative) instead of amplifying it.
    let score = clamp(recentDrift * 55, -70, 70);
    // An extreme z-score is an exhaustion warning: it partially offsets the
    // trend read rather than reversing it outright.
    const overextended = Math.abs(z) > 2.0;
    if (overextended) score -= Math.sign(z) * 15;
    score += clamp(dbImbalance * 60, -25, 25);
    score = clamp(score, -100, 100);

    const reasoning = [
      `Minimum stationary order d = ${chosen.d.toFixed(2)} (ADF t = ${chosen.tStat.toFixed(2)}, p = ${chosen.pValue.toFixed(3)}) — ${chosen.pValue < 0.05 ? 'STATIONARY' : 'NON-STATIONARY even at d=1'}`,
      `Memory retained after differencing: ${(chosen.memory * 100).toFixed(1)}% correlation with the log-price level`,
      `Stationary-series z-score ${z >= 0 ? '+' : ''}${z.toFixed(2)} — ${overextended ? `${Math.abs(z).toFixed(1)}σ from the mean, statistically stretched` : 'within normal dispersion'}`,
      `Quarterly drift ${recentDrift >= 0 ? '+' : ''}${recentDrift.toFixed(2)}σ — ${recentDrift > 0.2 ? 'persistent upward structure' : recentDrift < -0.2 ? 'persistent downward structure' : 'no durable drift'}`,
      `Dollar-bar order flow: ${imbalanceState} (aggressor metric ${dbImbalance.toFixed(3)}) across ${dBars.length} dollar bars`,
    ];

    return {
      score,
      confidence: clamp(0.4 + (chosen.pValue < 0.05 ? 0.25 : 0) + Math.min(Math.abs(recentDrift) * 0.3, 0.25), 0, 0.9),
      reasoning,
      metrics: {
        optimalD: chosen.d,
        adfTStat: Number(chosen.tStat.toFixed(2)),
        adfPValue: Number(chosen.pValue.toFixed(3)),
        stationarityStatus: chosen.pValue < 0.05 ? 'STATIONARY' : 'NON_STATIONARY',
        memoryRetained: Number(chosen.memory.toFixed(3)),
        zScore: Number(z.toFixed(2)),
        quarterlyDriftSigma: Number(recentDrift.toFixed(2)),
        dollarBarCount: dBars.length,
        imbalanceState,
        aggressorMetric: Number(dbImbalance.toFixed(3)),
        dSweep: sweep.filter((x) => x.pValue != null),
      },
      payload: { optimalD: chosen.d, zScore: z, overextended, imbalanceState },
    };
  }
}
