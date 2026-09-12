import { BaseAgent, gradeLinear } from './BaseAgent.js';
import { CLUSTERS } from '../config/constants.js';
import { closes } from '../lib/indicators.js';
import { clamp } from '../lib/stats.js';

/* ------------------------------------------------------------------ *
 * 7. Intermarket / Macro
 * ------------------------------------------------------------------ */

/**
 * High-multiple NASDAQ growth is a long-duration asset: it is priced off the
 * discount rate. This agent tracks the 10-year yield, the dollar, volatility,
 * the curve, credit spreads and breadth, and produces both a RISK_ON/RISK_OFF
 * regime and a "tech multiple headwind" score on [-5, +5].
 *
 * It also runs the Intermarket Threat Radar: a yield spike combined with
 * elevated volatility forces portfolio-wide de-leveraging.
 */
export class IntermarketMacroAgent extends BaseAgent {
  constructor() {
    super({
      id: 'Intermarket_Macro_Agent',
      name: 'Intermarket & Macro Regime',
      cluster: CLUSTERS.MACRO,
      description: '10Y yields, DXY, VIX/VXN, 3m/10y curve, credit stress and universe breadth into a risk-on/risk-off regime.',
    });
  }

  async analyze(ctx) {
    const m = ctx.macro;

    // Each channel scored so that positive = supportive of high-multiple tech.
    const rateScore = gradeLinear(-m.tnxChange20d, -0.35, 0.15) * 0.5 + gradeLinear(-m.tnx, -5.5, -3.5) * 0.5;
    const dollarScore = gradeLinear(-m.dxyChange20d, -2.5, 1.0);
    const volScore = gradeLinear(-m.vxn, -32, -16);
    // Credit: the proxy is 20-day HY underperformance vs IG in percentage
    // points, so a larger positive number means widening stress.
    const creditScore = gradeLinear(-m.creditStressProxy, -1.5, 0.5);
    const breadthScore = gradeLinear(m.advanceDeclineSlope, -0.6, 0.6) * 0.6
      + gradeLinear(m.newHighsMinusLows, -120, 120) * 0.4;
    const curveScore = gradeLinear(m.yieldCurve3m10s, -0.5, 1.0);

    const weights = { rate: 0.30, dollar: 0.10, vol: 0.22, credit: 0.15, breadth: 0.18, curve: 0.05 };
    const parts = { rate: rateScore, dollar: dollarScore, vol: volScore, credit: creditScore, breadth: breadthScore, curve: curveScore };
    const score = clamp(Object.entries(weights).reduce((a, [k, w]) => a + parts[k] * w, 0), -100, 100);

    const regime = score > 25 ? 'RISK_ON' : score < -25 ? 'RISK_OFF' : 'NEUTRAL';
    const headwindScore = Number(clamp(score / 20, -5, 5).toFixed(1));

    // Threat radar: a yield spike into elevated volatility is the specific
    // combination that de-rates growth multiples fastest.
    const threatRadar = m.tnxChange20d > 0.25 && m.vix > 25;

    // Breadth divergence: index-level strength unconfirmed by participation.
    const benchCloses = closes(ctx.benchmarkBars);
    const benchUp = benchCloses.at(-1) > benchCloses.at(-21);
    const breadthDivergence = benchUp && m.newHighsMinusLows < 0;

    const reasoning = [
      `Macro regime ${regime} (composite ${score.toFixed(0)}); tech multiple headwind score ${headwindScore > 0 ? '+' : ''}${headwindScore}`,
      `10-year yield ${m.tnx}% (${m.tnxChange20d >= 0 ? '+' : ''}${m.tnxChange20d} over 20 sessions) — ${m.tnxChange20d > 0.15 ? 'rising rates compress long-duration multiples' : 'rates are not an active headwind'}`,
      `VIX ${m.vix} / VXN ${m.vxn} — ${m.vxn > 28 ? 'elevated NASDAQ volatility, size down' : m.vxn < 18 ? 'calm volatility regime' : 'moderate volatility'}`,
      `3m/10y curve ${m.yieldCurve3m10s > 0 ? '+' : ''}${m.yieldCurve3m10s}% — ${m.yieldCurve3m10s < 0 ? 'INVERTED, historically a recession signal' : 'positively sloped'}`,
      `Credit stress proxy ${m.creditStressProxy > 0 ? '+' : ''}${m.creditStressProxy} (high yield ${m.creditStressProxy > 0 ? 'underperforming' : 'outperforming'} investment grade over 20 sessions) — ${m.creditStressProxy > 1 ? 'stress building' : 'credit conditions orderly'}`,
      m.sampleSize
        ? `Breadth across ${m.sampleSize} universe names: ${m.percentAboveMa50}% above their 50-day average, ${m.newHighs} new highs vs ${m.newLows} new lows`
        : `Breadth: A/D slope ${m.advanceDeclineSlope}, net new highs ${m.newHighsMinusLows}`,
    ];
    if (threatRadar) reasoning.push('THREAT RADAR: yields spiking with VIX above 25 — portfolio leverage should be dialled down across high-beta growth');
    if (breadthDivergence) reasoning.push('Breadth divergence: the index is up over 20 sessions while net new highs are negative');

    return {
      score,
      confidence: clamp(0.5 + Math.abs(score) / 260, 0, 0.85),
      reasoning,
      metrics: {
        regime,
        techMultipleHeadwind: headwindScore,
        tnx: m.tnx,
        tnxChange20d: m.tnxChange20d,
        dxy: m.dxy,
        vix: m.vix,
        vxn: m.vxn,
        yieldCurve3m10s: m.yieldCurve3m10s,
        bill3m: m.bill3m,
        creditStressProxy: m.creditStressProxy,
        percentAboveMa50: m.percentAboveMa50,
        newHighs: m.newHighs,
        newLows: m.newLows,
        newHighsMinusLows: m.newHighsMinusLows,
        breadthSampleSize: m.sampleSize,
        dataSource: m.source ?? 'MODELLED',
        breadthDivergence,
        threatRadarTriggered: threatRadar,
        channelScores: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Number(v.toFixed(1))])),
      },
      payload: { regime, threatRadar, headwindScore, vxn: m.vxn, breadthDivergence, macroSource: m.source ?? 'MODELLED' },
    };
  }
}
