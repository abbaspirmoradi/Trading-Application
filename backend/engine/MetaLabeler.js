// Meta-labeling layer (López de Prado, Ch. 3).
//
// The primary model decides DIRECTION. The meta-model decides whether to take
// that bet at all, and how big — it predicts P(the primary signal reaches its
// profit barrier before its stop barrier). This separation is what lets a
// mediocre-precision primary model become a high-Sharpe strategy: you keep the
// recall of the primary and buy precision from the secondary.
//
// The classifier here is a genuine logistic regression fitted at request time on
// the ticker's OWN history, labelled by the triple-barrier method. Training
// samples stop `horizon` bars before the present so every label is fully
// observed — there is no look-ahead. Features are standardised on the training
// set and the same transform is applied at inference.

import { closes, sma, atr, macd, rsi } from '../lib/indicators.js';
import { mean, stdev, sigmoid, clamp } from '../lib/stats.js';
import { BARRIERS } from '../config/constants.js';

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
const CACHE_TTL_MS = 5 * 60_000;

/** Feature vector at bar `i`. Uses only information available at or before `i`. */
function featuresAt(bars, benchCloses, i, pre) {
  const { px, ma150, atrSeries, macdHist, rsiSeries, vol, volMa20 } = pre;
  if (i < 260 || ma150[i] == null || atrSeries[i] == null) return null;

  const priceVs150 = px[i] / ma150[i] - 1;

  const stock63 = px[i] / px[i - 63] - 1;
  const bIdx = Math.min(i, benchCloses.length - 1);
  const bench63 = benchCloses[bIdx] / benchCloses[Math.max(0, bIdx - 63)] - 1;
  const relPerf = stock63 - bench63;

  const volRatio = volMa20[i] ? vol[i] / volMa20[i] : 1;
  const atrPct = atrSeries[i] / px[i];
  const mh = (macdHist[i] ?? 0) / px[i];
  const rsiNorm = ((rsiSeries[i] ?? 50) - 50) / 50;

  const high252 = Math.max(...px.slice(Math.max(0, i - 251), i + 1));
  const distHigh = px[i] / high252 - 1;

  const f = [priceVs150, relPerf, volRatio, atrPct, mh, rsiNorm, distHigh];
  return f.every(Number.isFinite) ? f : null;
}

/**
 * Triple-barrier label: walking forward from `i`, which barrier is touched
 * first? 1 = profit target, 0 = stop or time-out below entry.
 */
function labelAt(bars, i, atrNow, horizon, side) {
  const entry = bars[i].close;
  const up = side > 0 ? entry + BARRIERS.profitAtrMultiple * atrNow : entry - BARRIERS.profitAtrMultiple * atrNow;
  const dn = side > 0 ? entry - BARRIERS.stopAtrMultiple * atrNow : entry + BARRIERS.stopAtrMultiple * atrNow;

  for (let j = i + 1; j <= Math.min(i + horizon, bars.length - 1); j++) {
    if (side > 0) {
      if (bars[j].low <= dn) return 0;   // stop touched first
      if (bars[j].high >= up) return 1;  // target touched first
    } else {
      if (bars[j].high >= dn) return 0;
      if (bars[j].low <= up) return 1;
    }
  }
  // Time barrier: label by whether the trade was in profit when it expired.
  const last = bars[Math.min(i + horizon, bars.length - 1)].close;
  return side > 0 ? (last > entry ? 1 : 0) : (last < entry ? 1 : 0);
}

/** Ridge-regularised logistic regression by batch gradient descent. */
function fitLogistic(X, y, { epochs = 400, lr = 0.35, l2 = 0.01 } = {}) {
  const n = X.length;
  const k = X[0].length;
  const w = new Array(k).fill(0);
  let b = 0;

  for (let e = 0; e < epochs; e++) {
    const gw = new Array(k).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < k; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      gb += err;
      for (let j = 0; j < k; j++) gw[j] += err * X[i][j];
    }
    b -= lr * (gb / n);
    for (let j = 0; j < k; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  return { w, b };
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
  return { mu, sd, Z: X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j])) };
}

/**
 * Fits (or returns a cached) meta-model for one ticker and scores the latest
 * bar. `side` is the primary model's direction: +1 long, -1 short.
 */
export function metaLabel(ctx, side) {
  const key = `${ctx.ticker}:${side}:${ctx.asOf}`;
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const bars = ctx.bars;
  const benchCloses = closes(ctx.benchmarkBars);
  const px = closes(bars);
  const vol = bars.map((b) => b.volume);

  const pre = {
    px,
    vol,
    ma150: sma(px, 150),
    volMa20: sma(vol, 20),
    atrSeries: atr(bars, BARRIERS.atrPeriod),
    macdHist: macd(px).hist,
    rsiSeries: rsi(px, 14),
  };

  const horizon = BARRIERS.maxHoldingDays;
  const X = [];
  const y = [];

  // Only sample bars whose full barrier window has already elapsed.
  for (let i = 260; i < bars.length - horizon - 1; i++) {
    const f = featuresAt(bars, benchCloses, i, pre);
    if (!f) continue;
    X.push(f);
    y.push(labelAt(bars, i, pre.atrSeries[i], horizon, side));
  }

  const live = featuresAt(bars, benchCloses, bars.length - 1, pre);

  // Not enough observed outcomes, or a degenerate single-class label set —
  // fall back to the base rate rather than pretending to a fitted model.
  const positives = y.reduce((a, v) => a + v, 0);
  if (X.length < 60 || !live || positives === 0 || positives === y.length) {
    const base = X.length ? positives / y.length : 0.5;
    const value = {
      probability: clamp(base || 0.5, 0.05, 0.95),
      method: 'BASE_RATE',
      trainingSamples: X.length,
      baseRate: Number((base || 0.5).toFixed(3)),
      note: X.length < 60 ? 'Insufficient labelled history to fit the meta-model' : 'Labels are single-class over this history',
      featureImportance: [],
    };
    modelCache.set(key, { at: Date.now(), value });
    return value;
  }

  const { mu, sd, Z } = standardise(X);
  const model = fitLogistic(Z, y);

  // In-sample accuracy and Brier score — reported so the UI can show how much
  // the meta-model should actually be trusted.
  let correct = 0;
  let brier = 0;
  for (let i = 0; i < Z.length; i++) {
    let z = model.b;
    for (let j = 0; j < model.w.length; j++) z += model.w[j] * Z[i][j];
    const p = sigmoid(z);
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
    brier += (p - y[i]) ** 2;
  }

  const liveZ = live.map((v, j) => (v - mu[j]) / sd[j]);
  let z = model.b;
  for (let j = 0; j < model.w.length; j++) z += model.w[j] * liveZ[j];
  const probability = clamp(sigmoid(z), 0.02, 0.98);

  const featureImportance = FEATURE_NAMES
    .map((name, j) => ({ feature: name, weight: Number(model.w[j].toFixed(3)), value: Number(live[j].toFixed(4)), contribution: Number((model.w[j] * liveZ[j]).toFixed(3)) }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const value = {
    probability: Number(probability.toFixed(4)),
    method: 'LOGISTIC_TRIPLE_BARRIER',
    trainingSamples: X.length,
    baseRate: Number((positives / y.length).toFixed(3)),
    inSampleAccuracy: Number((correct / Z.length).toFixed(3)),
    brierScore: Number((brier / Z.length).toFixed(4)),
    horizonDays: horizon,
    featureImportance,
  };
  modelCache.set(key, { at: Date.now(), value });
  return value;
}

export { FEATURE_NAMES };
