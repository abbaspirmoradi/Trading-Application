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
