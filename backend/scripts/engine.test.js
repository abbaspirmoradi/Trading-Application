import test from 'node:test';
import assert from 'node:assert/strict';

import { computeKellySize } from '../engine/KellyEngine.js';
import { evaluateVetoes } from '../engine/VetoEngine.js';
import { buildBarriers } from '../agents/RiskAgents.js';
import { runAnalysis } from '../engine/ManagerOrchestrator.js';
import { buildMarketContext } from '../data/marketDataService.js';
import { AGENT_IDS } from '../agents/index.js';
import { fracDiff, adfTest } from '../lib/indicators.js';
import { BARRIERS } from '../config/constants.js';
import { seededRandom, adfPValue } from '../lib/stats.js';

const agent = (agentId, cluster, payload, score = 0) => ({
  agentId, cluster, status: 'COMPLETE', score, confidence: 0.8, signal: 'NEUTRAL', payload, reasoning: [], metrics: {},
});

const OK_BARRIERS = { riskRewardRatio: 3.0, riskPerShare: 2, stopLoss: 98, profitTarget: 106 };

test('Kelly: f* = (p(b+1)-1)/b', () => {
  const r = computeKellySize({
    winProbability: 0.6, payoffRatio: 2, equity: 100000, price: 100,
    riskPerShare: 5, maxRiskDollar: 1000, maxPositionDollar: 5000,
  });
  assert.equal(r.fullKelly, 0.4); // (0.6*3-1)/2 = 0.4
  assert.equal(r.fractionalKelly, 0.1); // quarter-Kelly
});

test('Kelly: a negative edge sizes to zero', () => {
  const r = computeKellySize({
    winProbability: 0.25, payoffRatio: 1.5, equity: 100000, price: 100,
    riskPerShare: 5, maxRiskDollar: 1000, maxPositionDollar: 5000,
  });
  assert.ok(r.fullKelly < 0);
  assert.equal(r.suggestedShares, 0);
});

test('Kelly: the per-trade risk limit binds before Kelly when the stop is wide', () => {
  const r = computeKellySize({
    winProbability: 0.9, payoffRatio: 5, equity: 100000, price: 100,
    riskPerShare: 40, maxRiskDollar: 1000, maxPositionDollar: 5000,
  });
  assert.equal(r.suggestedShares, 25); // 1000 / 40
  assert.match(r.bindingConstraint, /risk limit/);
});

test('Kelly: position value never exceeds the 5% hard cap', () => {
  const r = computeKellySize({
    winProbability: 0.95, payoffRatio: 10, equity: 100000, price: 100,
    riskPerShare: 0.5, maxRiskDollar: 5000, maxPositionDollar: 5000,
  });
  assert.ok(r.allocationDollar <= 5000);
});

test('Veto: Stage 4 blocks a long no matter how bullish everything else is', () => {
  const results = [
    agent('Weinstein_Stage_Agent', 'TECHNICAL', { stage: 4 }, -90),
    agent('Chart_Pattern_Agent', 'TECHNICAL', {}, 95),
    agent('Relative_Strength_Agent', 'TECHNICAL', {}, 95),
  ];
  const v = evaluateVetoes(results, 1, OK_BARRIERS);
  assert.ok(v.blocked);
  assert.equal(v.sizeMultiplier, 0);
  assert.ok(v.vetoes.some((x) => x.code === 'STAGE_4_VETO'));
});

test('Veto: Stage 4 does NOT block a short', () => {
  const results = [agent('Weinstein_Stage_Agent', 'TECHNICAL', { stage: 4 }, -90)];
  const v = evaluateVetoes(results, -1, OK_BARRIERS);
  assert.equal(v.blocked, false);
});

test('Veto: Stage 2 blocks shorting a confirmed advance', () => {
  const results = [agent('Weinstein_Stage_Agent', 'TECHNICAL', { stage: 2 }, 80)];
  const v = evaluateVetoes(results, -1, OK_BARRIERS);
  assert.ok(v.vetoes.some((x) => x.code === 'STAGE_2_SHORT_VETO'));
  assert.ok(v.blocked);
});

test('Veto: an unconfirmed breakout halves the size rather than blocking', () => {
  const results = [
    agent('Volume_OrderFlow_Agent', 'TECHNICAL', { hasBreakout: true, volumeConfirmed: false, volumeRatio: 0.9 }, -20),
  ];
  const v = evaluateVetoes(results, 1, OK_BARRIERS);
  assert.equal(v.blocked, false);
  assert.equal(v.sizeMultiplier, 0.5);
});

test('Veto: portfolio heat breach blocks all new risk', () => {
  const results = [
    agent('Portfolio_Risk_Agent', 'RISK', { heatBreach: true, correlationBreach: false, portfolioHeatPct: 7.2, maxCorrelation: 0.2 }, -80),
  ];
  const v = evaluateVetoes(results, 1, OK_BARRIERS);
  assert.ok(v.blocked);
  assert.ok(v.vetoes.some((x) => x.code === 'PORTFOLIO_HEAT_BREACH'));
});

test('Veto: correlation above 0.70 blocks a duplicated risk factor', () => {
  const results = [
    agent('Portfolio_Risk_Agent', 'RISK', { heatBreach: false, correlationBreach: true, portfolioHeatPct: 1, maxCorrelation: 0.82 }, -60),
  ];
  const v = evaluateVetoes(results, 1, OK_BARRIERS);
  assert.ok(v.blocked);
});

test('Veto: reward:risk below 1:1 blocks the entry', () => {
  const v = evaluateVetoes([], 1, { riskRewardRatio: 0.8 });
  assert.ok(v.blocked);
  assert.ok(v.vetoes.some((x) => x.code === 'REWARD_RISK_FLOOR'));
});

test('Veto: downgrade multipliers compound', () => {
  const results = [
    agent('Volume_OrderFlow_Agent', 'TECHNICAL', { hasBreakout: true, volumeConfirmed: false, volumeRatio: 0.9 }),
    agent('Intermarket_Macro_Agent', 'MACRO', { threatRadar: true }),
  ];
  const v = evaluateVetoes(results, 1, OK_BARRIERS);
  assert.equal(v.sizeMultiplier, 0.25); // 0.5 * 0.5
});

test('Barriers: a long stop sits below entry and the target above, with R:R > 0', () => {
  const b = buildBarriers({ price: 100, atrNow: 2, ma30w: 95, swingLow: 96, swingHigh: 104, direction: 'LONG' });
  assert.ok(b.stopLoss < 100);
  assert.ok(b.profitTarget > 100);
  assert.ok(b.riskRewardRatio > 0);
});

test('Barriers: a short mirrors the long geometry', () => {
  const b = buildBarriers({ price: 100, atrNow: 2, ma30w: 105, swingLow: 96, swingHigh: 104, direction: 'SHORT' });
  assert.ok(b.stopLoss > 100);
  assert.ok(b.profitTarget < 100);
});

test('Barriers: structure is preferred over the ATR stop when it is close enough', () => {
  // Derived from the ACTIVE horizon profile rather than hardcoded, so the test
  // asserts the rule (prefer viable structure) instead of numbers that only
  // hold for one holding period.
  const atrNow = 2;
  const minDistance = BARRIERS.minStopAtrMultiple * atrNow;
  const atrDistance = BARRIERS.stopAtrMultiple * atrNow;
  const wanted = (minDistance + atrDistance) / 2; // comfortably inside both bounds
  const swingLow = (100 - wanted) / 0.985;        // undo the buffer buildBarriers applies

  const b = buildBarriers({ price: 100, atrNow, ma30w: 60, swingLow, swingHigh: 104, direction: 'LONG' });
  assert.match(b.stopBasis, /reaction low/, `stop basis was "${b.stopBasis}" at horizon ${BARRIERS.horizon}`);
});

test('Barriers: the position horizon rejects a stop that a swing horizon would accept', () => {
  // A stop 3.5% away is reasonable over weeks and pure noise over years.
  const b = buildBarriers({ price: 100, atrNow: 2, ma30w: 90, swingLow: 98, swingHigh: 104, direction: 'LONG' });
  const distance = 100 - b.stopLoss;
  assert.ok(
    distance >= BARRIERS.minStopAtrMultiple * 2,
    `stop sat ${distance.toFixed(2)} away, inside the ${(BARRIERS.minStopAtrMultiple * 2).toFixed(2)} noise floor for ${BARRIERS.horizon}`,
  );
});

test('Barriers: absurdly distant structure falls back to the volatility stop', () => {
  const b = buildBarriers({ price: 100, atrNow: 2, ma30w: 40, swingLow: 45, swingHigh: 104, direction: 'LONG' });
  assert.match(b.stopBasis, /ATR/);
});

test('Quorum: fewer than three active agents produces no decision', async () => {
  const ctx = await buildMarketContext('AAPL');
  const d = await runAnalysis({
    ticker: 'AAPL', activeAgentIds: ['Weinstein_Stage_Agent'], marketContext: ctx,
    portfolio: { equity: 100000, cash: 100000, positions: [] },
  });
  assert.equal(d.finalAction, 'HOLD');
  assert.equal(d.blocked, true);
  assert.match(d.blockReason, /Quorum not met/);
});

test('Orchestrator: only the selected agents run', async () => {
  const ctx = await buildMarketContext('AAPL');
  const ids = ['Weinstein_Stage_Agent', 'Chart_Pattern_Agent', 'Portfolio_Risk_Agent'];
  const d = await runAnalysis({
    ticker: 'AAPL', activeAgentIds: ids, marketContext: ctx,
    portfolio: { equity: 100000, cash: 100000, positions: [] },
  });
  assert.equal(d.agentBreakdown.length, 3);
  assert.deepEqual(d.agentBreakdown.map((a) => a.agentId).sort(), [...ids].sort());
});

test('Orchestrator: every agent completes on a full run and risk never votes', async () => {
  const ctx = await buildMarketContext('NVDA');
  const d = await runAnalysis({
    ticker: 'NVDA', activeAgentIds: AGENT_IDS, marketContext: ctx,
    portfolio: { equity: 250000, cash: 250000, positions: [] },
  });
  assert.equal(d.agentBreakdown.length, 8);
  assert.equal(d.agentBreakdown.filter((a) => a.status === 'ERROR').length, 0);
  const risk = d.consensus.contributions.find((c) => c.agentId === 'Portfolio_Risk_Agent');
  assert.equal(risk.directionalVote, false);
  assert.equal(risk.effectiveWeight, 0);
});

test('Orchestrator: risk limits are respected in the final sizing', async () => {
  const ctx = await buildMarketContext('NVDA');
  const equity = 250000;
  const d = await runAnalysis({
    ticker: 'NVDA', activeAgentIds: AGENT_IDS, marketContext: ctx,
    portfolio: { equity, cash: equity, positions: [] },
  });
  assert.ok(d.positionSizing.portfolioPercent <= 5.0001, 'never exceeds the 5% position cap');
  assert.ok(d.positionSizing.actualRiskPercent <= 1.0001, 'never risks more than 1% of equity');
});

test('Fractional differentiation: stationarity increases monotonically with d', () => {
  const rnd = seededRandom(42);
  let p = 100;
  const walk = [];
  for (let i = 0; i < 600; i++) { p += (rnd() - 0.5) * 2; walk.push(p); }

  const pLow = adfPValue(adfTest(fracDiff(walk, 0.1).series, 1).tStat);
  const pHigh = adfPValue(adfTest(fracDiff(walk, 0.9).series, 1).tStat);
  assert.ok(pHigh < pLow, 'higher d must be more stationary');
  assert.ok(adfPValue(adfTest(walk, 1).tStat) > 0.10, 'a raw random walk is not stationary');
});

test('Veto: an existing holding is an add, not a correlation breach', () => {
  const results = [
    agent('Portfolio_Risk_Agent', 'RISK', {
      heatBreach: false, correlationBreach: false, positionCapExhausted: false,
      portfolioHeatPct: 1, maxCorrelation: 0.2,
    }),
  ];
  const v = evaluateVetoes(results, 1, OK_BARRIERS);
  assert.equal(v.blocked, false, 'adding to a winner must not be blocked as a correlated duplicate');
});

test('Veto: an exhausted position cap blocks further adds', () => {
  const results = [
    agent('Portfolio_Risk_Agent', 'RISK', {
      heatBreach: false, correlationBreach: false, positionCapExhausted: true,
      portfolioHeatPct: 1, maxCorrelation: 0.2,
    }),
  ];
  const v = evaluateVetoes(results, 1, OK_BARRIERS);
  assert.ok(v.blocked);
  assert.ok(v.vetoes.some((x) => x.code === 'POSITION_CAP_REACHED'));
});

test('Risk agent: self-correlation is excluded, and the cap accounts for the existing holding', async () => {
  const ctx = await buildMarketContext('NVDA');
  const { PortfolioRiskAgent } = await import('../agents/RiskAgents.js');
  const equity = 250000;
  ctx.portfolio = {
    equity,
    cash: equity,
    positions: [{ ticker: 'NVDA', side: 'LONG', shares: 100, entryPrice: 30, currentPrice: 36, stopPrice: 28 }],
  };
  const r = await new PortfolioRiskAgent().run(ctx);
  assert.equal(r.payload.correlationBreach, false, 'holding the same ticker must not trip the correlation veto');
  assert.equal(r.payload.maxCorrelation, 0, 'self-correlation is excluded from the maximum');
  // 5% of 250k = 12,500 ceiling, minus the 3,600 already held.
  assert.ok(Math.abs(r.payload.maxPositionDollar - (12500 - 3600)) < 1, `headroom was ${r.payload.maxPositionDollar}`);
});

test('Synthetic data: every window reports the same current price', async () => {
  const { generateBars } = await import('../data/syntheticMarket.js');
  const prices = [120, 260, 400, 750].map((d) => generateBars('NVDA', d).at(-1).close);
  assert.equal(new Set(prices).size, 1, `quote strip and analysis must agree: got ${prices.join(', ')}`);
});

test('Synthetic data: a window is a strict suffix of the longer series', async () => {
  const { generateBars } = await import('../data/syntheticMarket.js');
  const long = generateBars('AAPL', 400);
  const short = generateBars('AAPL', 120);
  assert.deepEqual(short, long.slice(-120));
});

test('Barriers: a stop is never placed inside the daily noise band', () => {
  // Structure sits only 0.2 ATR away — too tight to survive an ordinary session.
  const b = buildBarriers({ price: 100, atrNow: 5, ma30w: 80, swingLow: 99.8, swingHigh: 104, direction: 'LONG' });
  const distance = 100 - b.stopLoss;
  assert.ok(distance >= 5 * 0.8, `stop was only ${distance.toFixed(2)} away against an ATR of 5`);
  assert.ok(b.riskRewardRatio <= 6, `reward:risk of ${b.riskRewardRatio} implies an unrealistically tight stop`);
});

test('Advisor: a breached stop is the top-priority alert', async () => {
  const { advisePortfolio } = await import('../engine/PortfolioAdvisor.js');
  const { getQuote } = await import('../data/marketDataService.js');
  const q = await getQuote('NVDA');
  const portfolio = {
    equity: 250000, cash: 200000, peakEquity: 250000,
    positions: [{
      _id: 'x', ticker: 'NVDA', side: 'LONG', shares: 100,
      entryPrice: q.price * 1.5, stopPrice: q.price * 1.2, openedAt: '2026-01-01',
    }],
  };
  const r = await advisePortfolio({ portfolio });
  assert.equal(r.alerts[0].severity, 'CRITICAL');
  assert.equal(r.alerts[0].code, 'STOP_BREACHED');
  assert.equal(r.holdings[0].verdict, 'EXIT');
});

test('Screener: no pick may carry a blocking veto', async () => {
  const { screenUniverse } = await import('../engine/Screener.js');
  const r = await screenUniverse({
    universe: ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMD', 'META'],
    portfolio: { equity: 100000, cash: 100000, positions: [] },
    force: true,
  });
  for (const p of r.picks) {
    assert.equal(p.blocked, false, `${p.ticker} was recommended despite a blocking veto`);
    assert.ok(p.suggestedShares > 0, `${p.ticker} was recommended with zero size`);
    assert.notEqual(p.stage, 4, `${p.ticker} was recommended while in a Stage 4 decline`);
  }
});

test('Execution plan: the profit target always sits beyond the entry price', async () => {
  const { runAnalysis } = await import('../engine/ManagerOrchestrator.js');
  const { buildMarketContext } = await import('../data/marketDataService.js');
  const { SCREENER_UNIVERSE } = await import('../config/constants.js');

  for (const ticker of SCREENER_UNIVERSE.slice(0, 12)) {
    const ctx = await buildMarketContext(ticker);
    const d = await runAnalysis({
      ticker, activeAgentIds: AGENT_IDS, marketContext: ctx,
      portfolio: { equity: 100000, cash: 100000, positions: [] },
    });
    const p = d.executionPlan;
    if (p.orderType === 'WATCH') {
      // The entry is out of reach, so there are no live levels — only projected
      // ones, anchored at the trigger rather than at spot.
      assert.equal(p.stopLoss, null, `${ticker}: a WATCH item exposed a live stop`);
      assert.ok(p.projected, `${ticker}: a WATCH item should still project its levels`);
      assert.ok(p.projected.profitTarget > p.projected.ifTriggeredAt, `${ticker}: projected target is not beyond the trigger`);
      assert.ok(p.projected.stopLoss < p.projected.ifTriggeredAt, `${ticker}: projected stop is not below the trigger`);
      continue;
    }
    if (p.orderType === 'NONE') continue; // HOLD: reference levels at spot are fine
    // Direction-aware: a short's target sits below its entry and its stop above.
    const isLong = p.side === 'BUY';
    if (isLong) {
      assert.ok(p.profitTarget > p.triggerPrice, `${ticker}: long target ${p.profitTarget} is not above entry ${p.triggerPrice}`);
      assert.ok(p.stopLoss < p.triggerPrice, `${ticker}: long stop ${p.stopLoss} is not below entry ${p.triggerPrice}`);
    } else {
      assert.ok(p.profitTarget < p.triggerPrice, `${ticker}: short target ${p.profitTarget} is not below entry ${p.triggerPrice}`);
      assert.ok(p.stopLoss > p.triggerPrice, `${ticker}: short stop ${p.stopLoss} is not above entry ${p.triggerPrice}`);
    }
    assert.ok(p.distanceToTriggerPct <= 8.01, `${ticker}: entry is ${p.distanceToTriggerPct}% from spot`);
  }
});

test('Macro: the generated snapshot is schema-compatible with the live one', async () => {
  const { generateMacro } = await import('../data/syntheticMarket.js');
  const m = generateMacro();
  // Every field the Intermarket agent reads must exist on both sources,
  // otherwise a fallback silently produces NaN scores.
  const required = [
    'vix', 'vxn', 'tnx', 'tnxChange20d', 'bill3m', 'yieldCurve3m10s',
    'dxy', 'dxyChange20d', 'oil', 'gold', 'creditStressProxy',
    'advanceDeclineSlope', 'newHighsMinusLows', 'percentAboveMa50',
  ];
  for (const k of required) {
    assert.ok(k in m, `generated macro is missing "${k}"`);
    assert.ok(Number.isFinite(m[k]), `generated macro "${k}" is not finite: ${m[k]}`);
  }
});

test('Macro: the Intermarket agent scores finitely on a generated snapshot', async () => {
  const { IntermarketMacroAgent } = await import('../agents/MacroSentimentAgents.js');
  const ctx = await buildMarketContext('AAPL');
  const r = await new IntermarketMacroAgent().run(ctx);
  assert.equal(r.status, 'COMPLETE', r.error);
  assert.ok(Number.isFinite(r.score), `score was ${r.score}`);
  assert.ok(['RISK_ON', 'RISK_OFF', 'NEUTRAL'].includes(r.payload.regime));
  assert.ok(r.reasoning.every((line) => !/NaN|undefined/.test(line)), `reasoning contains a bad value: ${r.reasoning.join(' | ')}`);
});

test('Caveats: effective opinions collapse to 1 for identical agents and N for independent ones', async () => {
  const { effectiveOpinions } = await import('../engine/Caveats.js');
  const identical = { agentRedundancy: { correlationMatrix: { A: { A: 1, B: 1, C: 1 }, B: { A: 1, B: 1, C: 1 }, C: { A: 1, B: 1, C: 1 } } } };
  const independent = { agentRedundancy: { correlationMatrix: { A: { A: 1, B: 0, C: 0 }, B: { A: 0, B: 1, C: 0 }, C: { A: 0, B: 0, C: 1 } } } };
  assert.equal(effectiveOpinions(['A', 'B', 'C'], identical), 1);
  assert.equal(effectiveOpinions(['A', 'B', 'C'], independent), 3);
});

test('Caveats: a meta-model with no out-of-sample skill produces a HIGH probability caveat', async () => {
  const { buildCaveats } = await import('../engine/Caveats.js');
  const meta = {
    method: 'BASE_RATE_AFTER_FAILED_VALIDATION',
    fittedProbability: 0.72, probability: 0.53, baseRate: 0.53,
    trainingSamples: 4000, effectiveSamples: 60, horizonDays: 252,
    validation: { verdict: 'NO_SKILL', summary: 'Does NOT beat the baseline.' },
  };
  const caveats = buildCaveats({ meta, consensus: {}, agentResults: [], dataSources: {}, direction: 1 });
  const c = caveats.find((x) => x.code === 'META_MODEL_NO_SKILL');
  assert.ok(c, 'no-skill caveat missing');
  assert.equal(c.severity, 'HIGH');
  assert.equal(c.appliesTo, 'probability');
  assert.match(c.detail, /72%/, 'should disclose the discarded fitted value');
});

test('Caveats: an over-firing pattern is flagged as uninformative', async () => {
  const { buildCaveats } = await import('../engine/Caveats.js');
  const agentResults = [{ agentId: 'Chart_Pattern_Agent', status: 'COMPLETE', cluster: 'TECHNICAL', payload: { pattern: 'Double Bottom' } }];
  const caveats = buildCaveats({ meta: null, consensus: {}, agentResults, dataSources: {}, direction: 1 });
  const c = caveats.find((x) => x.code === 'PATTERN_DETECTION_RATE');
  // Only asserts when calibration exists (it is committed, so it should).
  if (c) {
    assert.ok(c.severity === 'HIGH' || c.severity === 'MEDIUM', `Double Bottom at its measured rate should not be LOW, got ${c.severity}`);
  }
});

test('Caveats: agents reading generated data are named on the composite', async () => {
  const { buildCaveats } = await import('../engine/Caveats.js');
  const agentResults = [
    { agentId: 'Intermarket_Macro_Agent', agentName: 'Intermarket & Macro Regime', status: 'COMPLETE', cluster: 'MACRO', payload: {} },
    { agentId: 'Weinstein_Stage_Agent', agentName: 'Weinstein Stage', status: 'COMPLETE', cluster: 'TECHNICAL', payload: {} },
  ];
  // Under the synthetic provider the macro feed is generated; the caveat must name it.
  const caveats = buildCaveats({ meta: null, consensus: {}, agentResults, dataSources: { macro: 'MODELLED' }, direction: 1 });
  const c = caveats.find((x) => x.code === 'MODELLED_INPUTS');
  assert.ok(c);
  assert.match(c.title, /1 contributing agent/);
  assert.match(c.detail, /Intermarket/);
  assert.doesNotMatch(c.detail, /Weinstein/);
});

test('Meta-model: effective samples are far fewer than training labels at a long horizon', async () => {
  const { metaLabel } = await import('../engine/MetaLabeler.js');
  const ctx = await buildMarketContext('AAPL');
  const m = await metaLabel(ctx, 1);
  assert.ok(m.effectiveSamples < m.trainingSamples / 5,
    `overlapping ${m.horizonDays}-day labels should shrink ${m.trainingSamples} to well under a fifth, got ${m.effectiveSamples}`);
});

test('Meta-model: the shown probability never strays further from the base rate than the fitted one', async () => {
  const { metaLabel } = await import('../engine/MetaLabeler.js');
  for (const t of ['AAPL', 'NVDA', 'MSFT']) {
    const ctx = await buildMarketContext(t);
    const m = await metaLabel(ctx, 1);
    if (m.fittedProbability == null) continue;
    const fittedDist = Math.abs(m.fittedProbability - m.baseRate);
    const shownDist = Math.abs(m.probability - m.baseRate);
    assert.ok(shownDist <= fittedDist + 1e-9, `${t}: shrinkage moved the probability AWAY from the base rate`);
    if (m.validation.verdict === 'NO_SKILL') {
      assert.ok(Math.abs(m.probability - m.baseRate) < 1e-6, `${t}: NO_SKILL must show exactly the base rate`);
    }
  }
});
