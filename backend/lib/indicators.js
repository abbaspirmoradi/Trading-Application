// Technical indicator primitives. Every function takes plain arrays and returns
// plain arrays aligned to the input (leading values are `null` where undefined),
// so agents can index by bar without off-by-one bookkeeping.

import { mean, stdev, ols } from './stats.js';

export const closes = (bars) => bars.map((b) => b.close);
export const highs = (bars) => bars.map((b) => b.high);
export const lows = (bars) => bars.map((b) => b.low);
export const volumes = (bars) => bars.map((b) => b.volume);

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = mean(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rollingStdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) out[i] = stdev(values.slice(i - period + 1, i + 1));
  return out;
}

export function trueRange(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

/** Wilder-smoothed ATR. */
export function atr(bars, period = 14) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let prev = mean(tr.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const defined = line.filter((x) => x != null);
  const sigDefined = ema(defined, signalPeriod);
  const signal = new Array(values.length).fill(null);
  const offset = line.findIndex((x) => x != null);
  sigDefined.forEach((v, i) => { if (v != null) signal[offset + i] = v; });
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

/** Slope of a least-squares fit over the last `period` points, in % per bar. */
export function slopePercent(values, period) {
  const w = values.slice(-period).filter((v) => v != null);
  if (w.length < 3) return 0;
  const X = w.map((_, i) => [1, i]);
  const res = ols(X, w);
  if (!res) return 0;
  const level = mean(w);
  return level ? (res.beta[1] / level) * 100 : 0;
}

export function rollingMax(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) out[i] = Math.max(...values.slice(i - period + 1, i + 1));
  return out;
}

export function rollingMin(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) out[i] = Math.min(...values.slice(i - period + 1, i + 1));
  return out;
}

/**
 * Swing pivots: a bar is a pivot high if it is the max of the +/- `span` window.
 * Used by the pattern recognizer to build its skeleton of the price structure.
 */
export function pivots(bars, span = 5) {
  const hi = [];
  const lo = [];
  for (let i = span; i < bars.length - span; i++) {
    const win = bars.slice(i - span, i + span + 1);
    if (bars[i].high === Math.max(...win.map((b) => b.high))) hi.push({ index: i, price: bars[i].high, date: bars[i].date });
    if (bars[i].low === Math.min(...win.map((b) => b.low))) lo.push({ index: i, price: bars[i].low, date: bars[i].date });
  }
  return { highs: hi, lows: lo };
}

/** Aggregate daily bars into weekly bars (5 trading days per bucket). */
export function toWeekly(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i += 5) {
    const chunk = bars.slice(i, i + 5);
    if (!chunk.length) break;
    out.push({
      date: chunk[chunk.length - 1].date,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((a, b) => a + b.volume, 0),
    });
  }
  return out;
}

/**
 * Fractional differentiation weights for order d (López de Prado).
 *   w_0 = 1,  w_k = -w_{k-1} * (d - k + 1) / k
 * Truncated once |w_k| falls under `threshold`, which is what makes the
 * fixed-width window variant usable on a rolling basis.
 */
export function fracDiffWeights(d, threshold = 1e-4, maxLength = 400) {
  const w = [1];
  for (let k = 1; k < maxLength; k++) {
    const next = (-w[k - 1] * (d - k + 1)) / k;
    if (Math.abs(next) < threshold) break;
    w.push(next);
  }
  return w;
}

/**
 * Fixed-width-window fractional differentiation of a series.
 * `maxWindow` caps the weight vector so a long-memory d never consumes more
 * history than we actually have — without it, small d on a short series
 * silently yields an empty result.
 */
export function fracDiff(values, d, threshold = 1e-4, maxWindow = null) {
  const cap = maxWindow ?? Math.max(10, Math.floor(values.length / 3));
  const w = fracDiffWeights(d, threshold, cap);
  const width = w.length;
  if (values.length <= width) return { series: [], weights: w, window: width };
  const out = [];
  for (let i = width - 1; i < values.length; i++) {
    let acc = 0;
    for (let k = 0; k < width; k++) acc += w[k] * values[i - k];
    out.push(acc);
  }
  return { series: out, weights: w, window: width };
}

/**
 * Augmented Dickey-Fuller test with a constant term:
 *   Δy_t = α + β·y_{t-1} + Σ γ_i·Δy_{t-i} + ε
 * Stationarity is rejected when the t-stat on β is not sufficiently negative.
 */
export function adfTest(series, lags = 1) {
  const n = series.length;
  if (n < lags + 10) return { tStat: 0, beta: 0, usable: false };
  const dy = [];
  for (let i = 1; i < n; i++) dy.push(series[i] - series[i - 1]);

  const y = [];
  const X = [];
  for (let i = lags; i < dy.length; i++) {
    const row = [1, series[i]]; // constant, y_{t-1}
    for (let l = 1; l <= lags; l++) row.push(dy[i - l]);
    X.push(row);
    y.push(dy[i]);
  }
  if (X.length < X[0].length + 5) return { tStat: 0, beta: 0, usable: false };
  const res = ols(X, y);
  if (!res) return { tStat: 0, beta: 0, usable: false };

  // A near-zero residual variance means the input is deterministic (or
  // degenerate); the t-stat blows up and means nothing. Reject it rather than
  // reporting spurious hyper-significance.
  const scale = Math.abs(mean(series.map(Math.abs))) || 1;
  if (!Number.isFinite(res.sigma2) || res.sigma2 < (scale * 1e-10) ** 2) {
    return { tStat: 0, beta: res.beta[1], usable: false, degenerate: true };
  }
  return { tStat: res.t[1], beta: res.beta[1], usable: true, dof: res.dof };
}

/**
 * Dollar bars: sample a new bar every time cumulative traded dollar volume
 * crosses a threshold. Restores far better distributional properties than
 * chronological time bars.
 */
export function dollarBars(bars, threshold) {
  const out = [];
  let acc = 0;
  let bucket = [];
  for (const b of bars) {
    bucket.push(b);
    acc += b.close * b.volume;
    if (acc >= threshold) {
      out.push({
        date: b.date,
        open: bucket[0].open,
        high: Math.max(...bucket.map((x) => x.high)),
        low: Math.min(...bucket.map((x) => x.low)),
        close: b.close,
        volume: bucket.reduce((a, x) => a + x.volume, 0),
        dollarValue: acc,
        barsConsumed: bucket.length,
      });
      acc = 0;
      bucket = [];
    }
  }
  return out;
}

/**
 * Tick-rule order-flow imbalance: signs each bar by its close-to-close change
 * and accumulates signed volume, giving a crude but effective aggressor metric.
 */
export function orderFlowImbalance(bars, lookback = 20) {
  const win = bars.slice(-lookback);
  let signed = 0;
  let total = 0;
  let lastSign = 1;
  for (let i = 1; i < win.length; i++) {
    const d = win[i].close - win[i - 1].close;
    const sign = d === 0 ? lastSign : Math.sign(d);
    lastSign = sign;
    signed += sign * win[i].volume;
    total += win[i].volume;
  }
  return total ? signed / total : 0;
}
