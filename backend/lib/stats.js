// Small, dependency-free numerical toolkit: descriptive stats, OLS via normal
// equations, and the Dickey-Fuller critical-value table used by the ADF test.

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function variance(xs, ddof = 1) {
  if (xs.length <= ddof) return NaN;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - ddof);
}

export const stdev = (xs, ddof = 1) => Math.sqrt(variance(xs, ddof));

export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a1 = x[i] - mx;
    const b1 = y[i] - my;
    num += a1 * b1;
    dx += a1 * a1;
    dy += b1 * b1;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

/** Percentile rank of `value` inside `xs`, expressed 0..100. */
export function percentileRank(xs, value) {
  if (!xs.length) return 50;
  const below = xs.filter((x) => x < value).length;
  const equal = xs.filter((x) => x === value).length;
  return ((below + 0.5 * equal) / xs.length) * 100;
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Logistic squash used to turn unbounded z-like features into probabilities. */
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Ordinary least squares via normal equations (X'X)b = X'y with Gaussian
 * elimination + partial pivoting. Returns coefficients, residual variance and
 * the standard error / t-stat of every coefficient.
 */
export function ols(X, y) {
  const n = X.length;
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);

  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }

  const inv = invert(XtX);
  if (!inv) return null;

  const beta = new Array(k).fill(0);
  for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) beta[a] += inv[a][b] * Xty[b];

  let sse = 0;
  for (let i = 0; i < n; i++) {
    let fitted = 0;
    for (let a = 0; a < k; a++) fitted += X[i][a] * beta[a];
    sse += (y[i] - fitted) ** 2;
  }
  const dof = n - k;
  const sigma2 = dof > 0 ? sse / dof : NaN;
  const se = beta.map((_, a) => Math.sqrt(Math.max(sigma2 * inv[a][a], 0)));
  const t = beta.map((b, a) => (se[a] > 0 ? b / se[a] : 0));

  return { beta, se, t, sigma2, dof, sse };
}

/** Gauss-Jordan inverse. Returns null for singular matrices. */
export function invert(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const p = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row.slice(n));
}

// MacKinnon-style critical values for the ADF t-stat, constant-only model.
const ADF_CRIT = [
  [0.01, -3.43],
  [0.05, -2.86],
  [0.10, -2.57],
  [0.50, -1.02],
  [0.90, 0.60],
];

/** Piecewise-linear interpolation of the DF table into an approximate p-value. */
export function adfPValue(tStat) {
  if (tStat <= ADF_CRIT[0][1]) return 0.005;
  if (tStat >= ADF_CRIT[ADF_CRIT.length - 1][1]) return 0.99;
  for (let i = 0; i < ADF_CRIT.length - 1; i++) {
    const [p1, c1] = ADF_CRIT[i];
    const [p2, c2] = ADF_CRIT[i + 1];
    if (tStat >= c1 && tStat <= c2) {
      const w = (tStat - c1) / (c2 - c1);
      return p1 + w * (p2 - p1);
    }
  }
  return 0.5;
}

/** Deterministic PRNG (mulberry32) so synthetic data is reproducible per ticker. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
