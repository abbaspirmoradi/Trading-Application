import { BaseAgent, gradeLinear } from './BaseAgent.js';
import { CLUSTERS } from '../config/constants.js';
import { closes } from '../lib/indicators.js';
import { clamp, mean } from '../lib/stats.js';

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

/* ------------------------------------------------------------------ *
 * 8. Geopolitical & News
 * ------------------------------------------------------------------ */

/**
 * Recency-weighted sentiment extraction over the news flow, with explicit
 * weighting for the categories that actually move semiconductor and hardware
 * supply chains: export controls, tariffs, regional conflict, regulation.
 *
 * In production the `ctx.news` feed is where a RAG pipeline over live news and
 * EDGAR filings plugs in; the scoring logic below is provider-agnostic.
 */
export class GeopoliticalNewsAgent extends BaseAgent {
  constructor() {
    super({
      id: 'Geopolitical_News_Agent',
      name: 'Geopolitical & News Sentiment',
      cluster: CLUSTERS.SENTIMENT,
      description: 'Recency-weighted news sentiment, export-control/tariff/supply-chain risk flags, governance red flags.',
    });
  }

  async analyze(ctx) {
    const news = ctx.news || [];
    if (!news.length) {
      return { score: 0, confidence: 0.2, reasoning: ['No news flow in the lookback window'], metrics: { articleCount: 0 }, payload: { globalRiskLevel: 'LOW' } };
    }

    // Half-life of 36 hours: yesterday's headline matters, last week's does not.
    const weighted = news.map((n) => {
      const decay = Math.pow(0.5, (n.ageHours ?? 24) / 36);
      return { ...n, weight: decay, contribution: n.sentiment * decay };
    });
    const totalWeight = weighted.reduce((a, n) => a + n.weight, 0) || 1;
    const netSentiment = weighted.reduce((a, n) => a + n.contribution, 0) / totalWeight;

    const RISK_TAGS = ['geopolitical', 'tariff', 'supply_chain', 'regulatory'];
    const riskArticles = weighted.filter((n) => n.tags?.some((t) => RISK_TAGS.includes(t)));
    const riskPressure = riskArticles.reduce((a, n) => a + Math.max(0, -n.sentiment) * n.weight, 0);

    const globalRiskLevel = riskPressure > 1.2 ? 'EXTREME'
      : riskPressure > 0.7 ? 'HIGH'
        : riskPressure > 0.3 ? 'ELEVATED' : 'LOW';

    const insiderFlag = weighted.some((n) => n.tags?.includes('insider') && n.sentiment < 0);
    const governanceFlag = weighted.some((n) => n.tags?.includes('governance') && n.sentiment < 0);

    let score = clamp(netSentiment * 90, -100, 100);
    score -= riskPressure * 30;
    if (insiderFlag) score -= 8;
    if (governanceFlag) score -= 10;
    score = clamp(score, -100, 100);

    const affectedSectors = [...new Set(riskArticles.flatMap((n) => n.tags))].filter((t) => RISK_TAGS.includes(t));

    const reasoning = [
      `Net recency-weighted sentiment ${netSentiment >= 0 ? '+' : ''}${netSentiment.toFixed(2)} across ${news.length} items`,
      `Global risk level ${globalRiskLevel} (risk pressure ${riskPressure.toFixed(2)})`,
      ...weighted
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 3)
        .map((n) => `"${n.headline}" (${n.sentiment >= 0 ? '+' : ''}${n.sentiment.toFixed(2)}, ${n.ageHours}h ago)`),
    ];
    if (affectedSectors.length) reasoning.push(`Risk channels in play: ${affectedSectors.join(', ')}`);
    if (governanceFlag) reasoning.push('Governance red flag: executive turnover disclosed');
    if (insiderFlag) reasoning.push('Insider red flag: Form 4 selling by an officer');

    return {
      score,
      confidence: clamp(0.3 + Math.min(news.length / 12, 0.35) + Math.abs(netSentiment) * 0.2, 0, 0.8),
      reasoning,
      metrics: {
        articleCount: news.length,
        netSentiment: Number(netSentiment.toFixed(3)),
        globalRiskLevel,
        riskPressure: Number(riskPressure.toFixed(2)),
        affectedChannels: affectedSectors,
        insiderFlag,
        governanceFlag,
        headlines: weighted.map((n) => ({ headline: n.headline, sentiment: n.sentiment, ageHours: n.ageHours })),
      },
      payload: { globalRiskLevel, netSentiment, riskPressure },
    };
  }
}

/* ------------------------------------------------------------------ *
 * 9. Options Sentiment & Gamma
 * ------------------------------------------------------------------ */

/**
 * Dealer positioning shapes the distribution of outcomes. Above the gamma flip
 * dealers are long gamma and hedging suppresses realised volatility (mean
 * reverting); below it they are short gamma and hedging amplifies moves. The
 * call wall and put floor act as magnets and support.
 */
export class OptionsSentimentAgent extends BaseAgent {
  constructor() {
    super({
      id: 'Options_Sentiment_Agent',
      name: 'Options Sentiment & Gamma',
      cluster: CLUSTERS.SENTIMENT,
      description: 'Put/call ratio, IV percentile and skew, dealer gamma regime, call wall and put floor.',
    });
  }

  async analyze(ctx) {
    const o = ctx.options;
    const price = ctx.price;

    const gammaRegime = price > o.gammaFlip ? 'LONG_GAMMA' : 'SHORT_GAMMA';
    const distToCallWall = ((o.callWall - price) / price) * 100;
    const distToPutFloor = ((price - o.putFloor) / price) * 100;

    // Put/call is contrarian at the extremes and confirming in the middle.
    const pcScore = o.putCallRatio > 1.35 ? 35 // capitulation in puts -> contrarian bullish
      : o.putCallRatio < 0.6 ? -30 // complacency -> contrarian bearish
        : gradeLinear(-o.putCallRatio, -1.2, -0.8) * 0.5;

    // Cheap optionality (low IV) favours long exposure; rich IV warns of an event.
    const ivScore = gradeLinear(-o.ivPercentile, -85, -25) * 0.6;
    const skewScore = gradeLinear(o.ivSkew, -5, 3) * 0.5;
    const gammaScore = gammaRegime === 'LONG_GAMMA' ? 22 : -28;
    const oiScore = clamp(o.openInterestShiftPct * 0.8, -25, 25);

    // Pinned right under the call wall is a poor entry: dealer hedging caps upside.
    const pinnedUnderWall = distToCallWall > 0 && distToCallWall < 1.5;

    let score = pcScore * 0.25 + ivScore * 0.2 + skewScore * 0.15 + gammaScore * 0.25 + oiScore * 0.15;
    if (pinnedUnderWall) score -= 12;
    score = clamp(score, -100, 100);

    const reasoning = [
      `Dealer gamma regime ${gammaRegime}: spot ${price.toFixed(2)} is ${price > o.gammaFlip ? 'above' : 'below'} the ${o.gammaFlip.toFixed(2)} flip level — ${gammaRegime === 'LONG_GAMMA' ? 'hedging dampens volatility, dips get bought' : 'hedging amplifies moves, expect volatility expansion'}`,
      `Put/call ratio ${o.putCallRatio} — ${o.putCallRatio > 1.35 ? 'extreme put demand, contrarian bullish' : o.putCallRatio < 0.6 ? 'call complacency, contrarian bearish' : 'unremarkable positioning'}`,
      `IV percentile ${o.ivPercentile} (${o.ivPercentile > 75 ? 'rich — an event is priced in' : o.ivPercentile < 25 ? 'cheap — options are an efficient way to express the view' : 'mid-range'}), skew ${o.ivSkew}`,
      `Call wall ${o.callWall.toFixed(2)} (${distToCallWall.toFixed(1)}% above), put floor ${o.putFloor.toFixed(2)} (${distToPutFloor.toFixed(1)}% below)`,
    ];
    if (pinnedUnderWall) reasoning.push('Spot is pinned just under the call wall — upside is capped until that strike clears');

    return {
      score,
      confidence: clamp(0.4 + Math.abs(score) / 300, 0, 0.8),
      reasoning,
      metrics: {
        gammaRegime,
        putCallRatio: o.putCallRatio,
        ivPercentile: o.ivPercentile,
        ivSkew: o.ivSkew,
        callWall: o.callWall,
        putFloor: o.putFloor,
        gammaFlip: o.gammaFlip,
        distanceToCallWallPct: Number(distToCallWall.toFixed(2)),
        distanceToPutFloorPct: Number(distToPutFloor.toFixed(2)),
        openInterestShiftPct: o.openInterestShiftPct,
      },
      payload: { gammaRegime, callWall: o.callWall, putFloor: o.putFloor, ivPercentile: o.ivPercentile },
    };
  }
}
