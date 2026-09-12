// Meta-labeling layer (López de Prado, Ch. 3–4, 7).
//
// The primary model decides DIRECTION. The meta-model decides whether to take
// that bet and how big, by predicting P(the profit barrier is reached before
// the stop). This version corrects three things the first one got wrong:
//
//   1. FULL HISTORY. Fitting on the 1300-bar analysis window at a 252-day
//      horizon yielded ~3 effective observations. Training now uses every bar
//      the provider has (up to 20 years).
//
//   2. SAMPLE UNIQUENESS (Ch. 4). Labels with a 252-day window overlap almost
//      entirely with their neighbours, so 4,000 samples are nowhere near 4,000
//      observations. Each sample's uniqueness = its average over its lifespan
//      of 1 / (number of concurrent labels). The sum of uniqueness is the
//      honest effective sample size, and each sample is weighted by it in the
//      fit so the redundant ones stop dominating.
//
//   3. PURGED HOLDOUT WITH EMBARGO (Ch. 7). Accuracy is now reported on a
//      time-ordered test set separated from training by one full horizon, so
//      no label in the test set was resolved with information the training set
//      saw. In-sample accuracy is still reported — labelled as such — beside it.
//
// The result carries every number needed to doubt it. That is the point.

import { closes, sma, atr, macd, rsi } from '../lib/indicators.js';
import { mean, stdev, sigmoid, clamp } from '../lib/stats.js';
import { BARRIERS } from '../config/constants.js';
import { getFullHistory } from '../data/marketDataService.js';

const FEATURE_NAMES = [
  'priceVs150dma',
  'relPerf63d',
  'volumeRatio20d',
  'atrPercent',
  'macdHistNorm',
  'rsi14Norm',
  'distFrom52wHigh',
];

const modelCache = new Map();
const CACHE_TTL_MS = 10 * 60_000;

/** Feature vector at bar `i`, using only information at or before `i`. */
function featuresAt(px, benchCloses, i, pre) {
  const { ma150, atrSeries, macdHist, rsiSeries, vol, volMa20 } = pre;
  if (i < 260 || ma150[i] == null || atrSeries[i] == null) return null;

  const priceVs150 = px[i] / ma150[i] - 1;
  const stock63 = px[i] / px[i - 63] - 1;
  const bIdx = Math.min(i, benchCloses.length - 1);
  const bench63 = benchCloses[bIdx] / benchCloses[Math.max(0, bIdx - 63)] - 1;
  const volRatio = volMa20[i] ? vol[i] / volMa20[i] : 1;
  const atrPct = atrSeries[i] / px[i];
  const mh = (macdHist[i] ?? 0) / px[i];
  const rsiNorm = ((rsiSeries[i] ?? 50) - 50) / 50;
  const high252 = Math.max(...px.slice(Math.max(0, i - 251), i + 1));
  const distHigh = px[i] / high252 - 1;

  const f = [priceVs150, stock63 - bench63, volRatio, atrPct, mh, rsiNorm, distHigh];
  return f.every(Number.isFinite) ? f : null;
}

/**
 * Triple-barrier label and the bar at which it resolved. The resolution bar
 * matters for uniqueness: a label that hit its target in ten days overlaps far
 * less than one that ran the full horizon.
 */
function labelAt(bars, i, atrNow, horizon, side) {
  const entry = bars[i].close;
  const up = side > 0 ? entry + BARRIERS.profitAtrMultiple * atrNow : entry - BARRIERS.profitAtrMultiple * atrNow;
  const dn = side > 0 ? entry - BARRIERS.stopAtrMultiple * atrNow : entry + BARRIERS.stopAtrMultiple * atrNow;
  const end = Math.min(i + horizon, bars.length - 1);

  for (let j = i + 1; j <= end; j++) {
    if (side > 0) {
      if (bars[j].low <= dn) return { y: 0, endIndex: j };
      if (bars[j].high >= up) return { y: 1, endIndex: j };
    } else {
      if (bars[j].high >= dn) return { y: 0, endIndex: j };
      if (bars[j].low <= up) return { y: 1, endIndex: j };
    }
  }
  const last = bars[end].close;
  return { y: side > 0 ? (last > entry ? 1 : 0) : (last < entry ? 1 : 0), endIndex: end };
}

/**
 * Average uniqueness per sample (López de Prado 4.2–4.3).
 * concurrency[t] = number of labels whose lifespan covers bar t;
 * uniqueness_i  = mean over i's lifespan of 1 / concurrency[t].
 */
function computeUniqueness(samples, barCount) {
  const diff = new Float64Array(barCount + 1);
  for (const s of samples) { diff[s.start] += 1; diff[s.end + 1] -= 1; }
  const concurrency = new Float64Array(barCount);
  let running = 0;
  for (let t = 0; t < barCount; t++) { running += diff[t]; concurrency[t] = running; }

  // Prefix sums of 1/c so each sample's average is O(1).
  const inv = new Float64Array(barCount + 1);
  for (let t = 0; t < barCount; t++) inv[t + 1] = inv[t] + (concurrency[t] > 0 ? 1 / concurrency[t] : 0);

  return samples.map((s) => (inv[s.end + 1] - inv[s.start]) / (s.end - s.start + 1));
}

/** Weighted, ridge-regularised logistic regression by batch gradient descent. */
function fitLogistic(X, y, w, { epochs = 400, lr = 0.35, l2 = 0.01 } = {}) {
  const n = X.length;
  const k = X[0].length;
  const beta = new Array(k).fill(0);
  let b = 0;
  const wsum = w.reduce((a, v) => a + v, 0) || n;

  for (let e = 0; e < epochs; e++) {
    const g = new Array(k).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < k; j++) z += beta[j] * X[i][j];
      const err = (sigmoid(z) - y[i]) * w[i];
      gb += err;
      for (let j = 0; j < k; j++) g[j] += err * X[i][j];
    }
    b -= lr * (gb / wsum);
    for (let j = 0; j < k; j++) beta[j] -= lr * (g[j] / wsum + l2 * beta[j]);
  }
  return { w: beta, b };
}

function standardise(X) {
  const k = X[0].length;
  const mu = [];
  const sd = [];
  for (let j = 0; j < k; j++) {
    const col = X.map((r) => r[j]);
    mu.push(mean(col));
    sd.push(stdev(col) || 1);
  }
  return { mu, sd, apply: (row) => row.map((v, j) => (v - mu[j]) / sd[j]) };
}

function predict(model, z) {
  let s = model.b;
  for (let j = 0; j < model.w.length; j++) s += model.w[j] * z[j];
  return sigmoid(s);
}

function evaluate(model, Z, y) {
  let correct = 0;
  let brier = 0;
  for (let i = 0; i < Z.length; i++) {
    const p = predict(model, Z[i]);
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
    brier += (p - y[i]) ** 2;
  }
  return { accuracy: correct / Z.length, brier: brier / Z.length };
}

/**
 * Fits (or returns a cached) meta-model for one ticker and scores the latest
 * bar. `side` is the primary model's direction: +1 long, -1 short.
 */
export async function metaLabel(ctx, side) {
  const key = `${ctx.ticker}:${side}:${ctx.asOf}:${BARRIERS.horizon}`;
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  // Train on everything the provider has, not the analysis window.
  let bars;
  try { bars = await getFullHistory(ctx.ticker); } catch { bars = ctx.bars; }
  const benchCloses = closes(ctx.benchmarkBars);
  const px = closes(bars);
  const vol = bars.map((b) => b.volume);
  const pre = {
    vol,
    ma150: sma(px, 150),
    volMa20: sma(vol, 20),
    atrSeries: atr(bars, BARRIERS.atrPeriod),
    macdHist: macd(px).hist,
    rsiSeries: rsi(px, 14),
  };
  const horizon = BARRIERS.maxHoldingDays;

  // Every sample's label must be fully resolved before the present.
  const samples = [];
  for (let i = 260; i < bars.length - horizon - 1; i++) {
    const f = featuresAt(px, benchCloses, i, pre);
    if (!f) continue;
    const { y, endIndex } = labelAt(bars, i, pre.atrSeries[i], horizon, side);
    samples.push({ start: i, end: endIndex, x: f, y });
  }

  const live = featuresAt(closes(ctx.bars), benchCloses, ctx.bars.length - 1, {
    ma150: sma(closes(ctx.bars), 150),
    volMa20: sma(ctx.bars.map((b) => b.volume), 20),
    atrSeries: atr(ctx.bars, BARRIERS.atrPeriod),
    macdHist: macd(closes(ctx.bars)).hist,
    rsiSeries: rsi(closes(ctx.bars), 14),
    vol: ctx.bars.map((b) => b.volume),
  });

  const positives = samples.reduce((a, s) => a + s.y, 0);
  const baseRate = samples.length ? positives / samples.length : 0.5;

  const uniqueness = computeUniqueness(samples, bars.length);
  const effectiveN = uniqueness.reduce((a, u) => a + u, 0);

  const fallback = (note) => {
    const value = {
      probability: clamp(baseRate || 0.5, 0.05, 0.95),
      method: 'BASE_RATE',
      trainingSamples: samples.length,
      effectiveSamples: Number(effectiveN.toFixed(1)),
      baseRate: Number(baseRate.toFixed(4)),
      horizonDays: horizon,
      note,
      featureImportance: [],
    };
    modelCache.set(key, { at: Date.now(), value });
    return value;
  };

  // Too little independent information to fit anything defensible.
  if (samples.length < 60 || !live) return fallback('Insufficient labelled history to fit the meta-model');
  if (positives === 0 || positives === samples.length) return fallback('Labels are single-class over this history');
  if (effectiveN < 15) return fallback(`Only ~${effectiveN.toFixed(0)} effectively independent observations after correcting for overlapping labels — too few to fit`);

  /* ---- Purged, embargoed holdout: time-ordered, gap of one horizon ---- */
  const cut = Math.floor(samples.length * 0.7);
  const trainEnd = samples[cut - 1].end;
  const train = samples.slice(0, cut);
  const test = samples.filter((s) => s.start > trainEnd + horizon);

  let outOfSample = null;
  if (test.length >= 30 && train.length >= 60) {
    const std = standardise(train.map((s) => s.x));
    const Ztr = train.map((s) => std.apply(s.x));
    const wtr = uniqueness.slice(0, cut);
    const m = fitLogistic(Ztr, train.map((s) => s.y), wtr);
    const Zte = test.map((s) => std.apply(s.x));
    const ev = evaluate(m, Zte, test.map((s) => s.y));
    const testBase = test.reduce((a, s) => a + s.y, 0) / test.length;
    outOfSample = {
      testSamples: test.length,
      accuracy: Number(ev.accuracy.toFixed(3)),
      brierScore: Number(ev.brier.toFixed(4)),
      majorityBaseline: Number(Math.max(testBase, 1 - testBase).toFixed(3)),
      // Positive = beats "always predict the common class". The honest bar.
      liftOverBaseline: Number((ev.accuracy - Math.max(testBase, 1 - testBase)).toFixed(3)),
    };
  }

  /* ---- Final fit on everything, for the live prediction ---- */
  const std = standardise(samples.map((s) => s.x));
  const Z = samples.map((s) => std.apply(s.x));
  const model = fitLogistic(Z, samples.map((s) => s.y), uniqueness);
  const inSample = evaluate(model, Z, samples.map((s) => s.y));

  const liveZ = std.apply(live);
  const fitted = clamp(predict(model, liveZ), 0.02, 0.98);

  // Shrink toward the base rate in proportion to DEMONSTRATED out-of-sample
  // skill. A model that cannot beat "always predict the common class" on data
  // it never saw earns no trust, and its fitted number is replaced by the
  // prior. Lift under two points is indistinguishable from noise and earns no
  // trust; ten points earns full trust; linear between. This keeps a
  // probability on screen, as asked, while making sure it is one the evidence
  // supports.
  const lift = outOfSample?.liftOverBaseline ?? 0;
  const trust = outOfSample ? clamp((lift - 0.02) / 0.08, 0, 1) : 0;
  const probability = clamp(baseRate + (fitted - baseRate) * trust, 0.02, 0.98);

  const validation = {
    trustFactor: Number(trust.toFixed(2)),
    verdict: !outOfSample ? 'UNVALIDATED'
      : lift >= 0.10 ? 'VALIDATED'
        : lift > 0.02 ? 'WEAK'
          : 'NO_SKILL',
    summary: !outOfSample
      ? 'No out-of-sample holdout could be formed; the probability shown is the historical base rate.'
      : lift >= 0.10
        ? `Beats the majority-class baseline by ${(lift * 100).toFixed(1)} points out-of-sample on ${outOfSample.testSamples} unseen labels.`
        : lift > 0.02
          ? `Only ${(lift * 100).toFixed(1)} points above the baseline out-of-sample — the fitted probability is shrunk ${((1 - trust) * 100).toFixed(0)}% toward the base rate.`
          : `Does NOT beat the majority-class baseline out-of-sample (lift ${(lift * 100).toFixed(1)} points). The probability shown is the historical base rate, not a model prediction.`,
  };

  const featureImportance = FEATURE_NAMES
    .map((name, j) => ({
      feature: name,
      weight: Number(model.w[j].toFixed(3)),
      value: Number(live[j].toFixed(4)),
      contribution: Number((model.w[j] * liveZ[j]).toFixed(3)),
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const value = {
    probability: Number(probability.toFixed(4)),
    fittedProbability: Number(fitted.toFixed(4)),
    method: trust > 0 ? 'LOGISTIC_TRIPLE_BARRIER' : 'BASE_RATE_AFTER_FAILED_VALIDATION',
    validation,
    trainingSamples: samples.length,
    effectiveSamples: Number(effectiveN.toFixed(1)),
    baseRate: Number(baseRate.toFixed(4)),
    inSampleAccuracy: Number(inSample.accuracy.toFixed(3)),
    brierScore: Number(inSample.brier.toFixed(4)),
    outOfSample,
    horizonDays: horizon,
    historyYears: Number((bars.length / 252).toFixed(1)),
    featureImportance,
  };
  modelCache.set(key, { at: Date.now(), value });
  return value;
}

export { FEATURE_NAMES };
