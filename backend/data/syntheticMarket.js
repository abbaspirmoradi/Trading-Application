// Deterministic synthetic market generator.
//
// Every series is derived from a hash of the ticker, so a given symbol always
// produces the same history: agent outputs are reproducible, testable, and the
// app runs with zero external dependencies or API keys. Prices are generated
// through a four-phase Weinstein-style regime cycle (base -> advance -> top ->
// decline) with a per-ticker starting phase, so the universe naturally contains
// stocks in every stage rather than all trending the same way.

import { seededRandom, hashString } from '../lib/stats.js';

const TRADING_DAYS = 750;

// The generator consumes its PRNG stream in proportion to the series length, so
// asking for a different number of bars would otherwise produce a *different
// price path* for the same ticker. Every request is therefore served as a suffix
// of one canonical series, which keeps the quote strip, the chart and the
// analysis all quoting the same price.
const CANONICAL_DAYS = 5100;

function gaussian(rnd) {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const PHASES = [
  { stage: 1, drift: 0.0000, volMult: 0.70 }, // basing: quiet, sideways
  { stage: 2, drift: 0.0016, volMult: 1.00 }, // advancing
  { stage: 3, drift: 0.0001, volMult: 1.25 }, // topping: churn
  { stage: 4, drift: -0.0015, volMult: 1.45 }, // declining
];

export function generateBars(ticker, days = TRADING_DAYS) {
  const canonical = buildCanonicalSeries(ticker, Math.max(days, CANONICAL_DAYS));
  return canonical.slice(-days);
}

function buildCanonicalSeries(ticker, days) {
  const seed = hashString(ticker.toUpperCase());
  const rnd = seededRandom(seed);

  const startPhase = seed % 4;
  const baseVol = 0.010 + (seed % 19) / 1200; // ~1.0% - 2.5% daily sigma
  let price = 18 + ((seed >>> 3) % 380);
  const baseVolume = 800_000 + ((seed >>> 5) % 40) * 900_000;

  // Build the phase schedule backwards from today so the *most recent* segment
  // is the one that determines the stock's current stage.
  const schedule = [];
  let remaining = days;
  let phaseIdx = startPhase;
  while (remaining > 0) {
    const len = Math.min(remaining, 70 + Math.floor(rnd() * 120));
    schedule.unshift({ ...PHASES[phaseIdx % 4], len });
    remaining -= len;
    phaseIdx += 3; // walk the cycle backwards
  }

  // Build the weekday calendar backwards from the most recent weekday so the
  // final bar is always "today" (or the preceding Friday).
  const calendar = [];
  const cursor = new Date();
  while (cursor.getDay() === 0 || cursor.getDay() === 6) cursor.setDate(cursor.getDate() - 1);
  while (calendar.length < days) {
    calendar.unshift(new Date(cursor));
    do { cursor.setDate(cursor.getDate() - 1); } while (cursor.getDay() === 0 || cursor.getDay() === 6);
  }

  const bars = [];
  let barIndex = 0;
  for (const phase of schedule) {
    for (let i = 0; i < phase.len; i++) {
      if (barIndex >= calendar.length) break;

      const sigma = baseVol * phase.volMult;
      const shock = gaussian(rnd) * sigma;
      const ret = phase.drift + shock;
      const open = price;
      price = Math.max(1, price * (1 + ret));

      const wick = Math.abs(gaussian(rnd)) * sigma * 0.6;
      const high = Math.max(open, price) * (1 + wick);
      const low = Math.min(open, price) * (1 - wick);

      // Volume expands on large up-moves (accumulation) and on capitulation.
      const impulse = 1 + Math.min(Math.abs(ret) / sigma, 4) * 0.45;
      const noise = 0.65 + rnd() * 0.8;
      const volume = Math.round(baseVolume * impulse * noise * phase.volMult);

      bars.push({
        date: calendar[barIndex].toISOString().slice(0, 10),
        open: round2(open),
        high: round2(high),
        low: round2(low),
        close: round2(price),
        volume,
      });
      barIndex++;
    }
  }

  return bars.slice(-days);
}

const round2 = (x) => Math.round(x * 100) / 100;

export function generateFundamentals(ticker, bars) {
  const seed = hashString(`${ticker}:fund`);
  const rnd = seededRandom(seed);

  // Anchor fundamentals loosely to realised price trend so the fundamental and
  // technical pictures are coherent rather than contradictory noise.
  const trend = bars.length > 260 ? bars.at(-1).close / bars.at(-260).close - 1 : 0;
  const bias = Math.max(-0.4, Math.min(0.6, trend));

  const epsGrowthQoQ = round1((bias * 90 + (rnd() - 0.35) * 60));
  const epsGrowthPrevQ = round1(epsGrowthQoQ * (0.5 + rnd() * 0.8));
  const salesGrowthQoQ = round1(epsGrowthQoQ * (0.45 + rnd() * 0.6));
  const annualEpsGrowth3y = round1(bias * 55 + (rnd() - 0.3) * 35);
  const roe = round1(6 + rnd() * 30 + bias * 12);

  const sharesOutstandingM = Math.round(60 + rnd() * 2400);
  const floatM = Math.round(sharesOutstandingM * (0.55 + rnd() * 0.42));

  const instHoldersQoQChange = round1(bias * 14 + (rnd() - 0.4) * 10);
  const instOwnershipPct = round1(Math.min(95, 35 + rnd() * 55));

  const debtToEquity = round2n(0.1 + rnd() * 2.4 - bias * 0.4, 2);
  const grossMarginPct = round1(28 + rnd() * 50);
  const grossMarginDeltaYoY = round1((rnd() - 0.4) * 8 + bias * 3);
  const fcfYieldPct = round2n(rnd() * 7 - 1 + bias * 1.5, 2);
  const evToEbitda = round1(6 + rnd() * 40 - bias * 4);

  return {
    ticker,
    epsGrowthQoQ,
    epsGrowthPrevQ,
    salesGrowthQoQ,
    annualEpsGrowth3y,
    roe,
    sharesOutstandingM,
    floatM,
    instHoldersQoQChange,
    instOwnershipPct,
    debtToEquity,
    grossMarginPct,
    grossMarginDeltaYoY,
    fcfYieldPct,
    evToEbitda,
    hasNewCatalyst: rnd() > 0.45,
    catalystNote: rnd() > 0.45 ? 'New product cycle / management change disclosed in latest 8-K' : 'No material new catalyst detected',
    // Financial-health inputs (Altman Z / Piotroski F components)
    workingCapitalToAssets: round2n(rnd() * 0.45 - 0.05, 2),
    retainedEarningsToAssets: round2n(rnd() * 0.6 - 0.1, 2),
    ebitToAssets: round2n(rnd() * 0.25 - 0.03 + bias * 0.05, 2),
    equityToLiabilities: round2n(0.3 + rnd() * 3, 2),
    salesToAssets: round2n(0.3 + rnd() * 1.6, 2),
    positiveNetIncome: rnd() > 0.25,
    positiveOperatingCF: rnd() > 0.2,
    cfoExceedsNetIncome: rnd() > 0.4,
    lowerLeverageYoY: rnd() > 0.5,
    sharesNotDiluted: rnd() > 0.45,
  };
}

export function generateOptionsChainSummary(ticker, price, bars) {
  const rnd = seededRandom(hashString(`${ticker}:opt`));
  const putCallRatio = round2n(0.55 + rnd() * 1.1, 2);
  const ivPercentile = Math.round(rnd() * 100);
  const ivSkew = round2n((rnd() - 0.5) * 12, 2);

  // Gamma walls cluster on round strikes around spot.
  const strikeStep = price > 200 ? 10 : price > 60 ? 5 : 2.5;
  const callWall = round2(Math.ceil((price * (1.03 + rnd() * 0.07)) / strikeStep) * strikeStep);
  const putFloor = round2(Math.floor((price * (0.93 - rnd() * 0.07)) / strikeStep) * strikeStep);
  const gammaFlip = round2(price * (0.97 + rnd() * 0.06));

  return { ticker, putCallRatio, ivPercentile, ivSkew, callWall, putFloor, gammaFlip, openInterestShiftPct: round1((rnd() - 0.5) * 60) };
}

export function generateNews(ticker) {
  const rnd = seededRandom(hashString(`${ticker}:news`));
  const pool = [
    { headline: `${ticker} expands APAC manufacturing footprint`, sentiment: 0.55, tags: ['supply_chain'] },
    { headline: `Analysts raise ${ticker} price target on AI demand`, sentiment: 0.72, tags: ['demand'] },
    { headline: `New export restrictions cloud ${ticker} shipments to China`, sentiment: -0.68, tags: ['geopolitical', 'tariff'] },
    { headline: `${ticker} CFO announces departure`, sentiment: -0.45, tags: ['governance'] },
    { headline: `${ticker} beats on revenue, guides light`, sentiment: 0.05, tags: ['earnings'] },
    { headline: `Taiwan Strait tensions pressure semiconductor supply`, sentiment: -0.6, tags: ['geopolitical', 'supply_chain'] },
    { headline: `${ticker} buyback authorisation increased`, sentiment: 0.5, tags: ['capital_return'] },
    { headline: `Sector rotation lifts megacap technology`, sentiment: 0.4, tags: ['flows'] },
    { headline: `${ticker} named in antitrust inquiry`, sentiment: -0.55, tags: ['regulatory'] },
    { headline: `Insider Form 4: officer sells 40k shares`, sentiment: -0.3, tags: ['insider'] },
  ];
  const count = 3 + Math.floor(rnd() * 4);
  const picked = [];
  const used = new Set();
  while (picked.length < count) {
    const i = Math.floor(rnd() * pool.length);
    if (used.has(i)) continue;
    used.add(i);
    picked.push({ ...pool[i], ageHours: Math.round(rnd() * 72) });
  }
  return picked;
}

export function generateMacro() {
  // Shape-compatible with the live snapshot in data/macroService.js so the
  // Intermarket agent reads one schema whatever the provenance.
  const rnd = seededRandom(hashString(new Date().toISOString().slice(0, 10)));
  const tnx = round2n(3.4 + rnd() * 1.6, 2);
  const bill3m = round2n(tnx - (-0.6 + rnd() * 1.8), 2);
  const vix = round1(11 + rnd() * 22);

  return {
    vix,
    vxn: round1(vix * (1.05 + rnd() * 0.25)),
    tnx,
    tnxChange20d: round2n((rnd() - 0.45) * 0.7, 2),
    bill3m,
    yieldCurve3m10s: round2n(tnx - bill3m, 2),
    dxy: round1(96 + rnd() * 12),
    dxyChange20d: round1((rnd() - 0.5) * 4),
    oil: round1(60 + rnd() * 40),
    gold: Math.round(1900 + rnd() * 800),
    creditStressProxy: round2n((rnd() - 0.55) * 3, 2),
    hygChange20dPct: round2n((rnd() - 0.5) * 2, 2),
    lqdChange20dPct: round2n((rnd() - 0.5) * 1.5, 2),
    advanceDeclineSlope: round2n((rnd() - 0.45) * 2, 2),
    percentAboveMa50: round1(rnd() * 100),
    newHighs: Math.round(rnd() * 6),
    newLows: Math.round(rnd() * 6),
    newHighsMinusLows: Math.round((rnd() - 0.42) * 300),
    sampleSize: 0,
    breadthSource: 'MODELLED',
    asOf: new Date().toISOString(),
  };
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2n = (x, n) => Number(x.toFixed(n));
