// Live macro feed.
//
// Every value here is fetched or derived from real market data — no invented
// numbers. Two honest caveats are encoded in the field names themselves:
//
//   * The curve is 3m/10y, not 2s10s. Yahoo exposes no reliable 2-year series,
//     and interpolating one would be fabrication dressed as data. The 3m/10y
//     spread is a well-established recession indicator in its own right.
//   * Credit stress is a PROXY: the 20-day relative performance of HYG against
//     LQD. The actual high-yield OAS is a licensed series; this measures the
//     same thing (high-yield underperforming investment grade) from free data.
//
// Breadth is computed from the screening universe rather than taken from an
// index provider, which makes it the real breadth of the names this system
// actually trades.

import { getBars, provider } from './marketDataService.js';
import { generateMacro } from './syntheticMarket.js';
import { mapLimit } from '../lib/concurrency.js';
import { closes, sma } from '../lib/indicators.js';
import { SCREENER_UNIVERSE } from '../config/constants.js';

const CACHE_TTL_MS = 10 * 60_000;
const BREADTH_SAMPLE = 30; // names sampled for breadth; each is a cached fetch

let cache = { at: 0, value: null };

const SERIES = {
  vix: '^VIX',
  vxn: '^VXN',
  tnx: '^TNX',
  bill3m: '^IRX',
  dxy: 'DX-Y.NYB',
  oil: 'CL=F',
  gold: 'GC=F',
  hyg: 'HYG',
  lqd: 'LQD',
};

async function fetchSeries(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; trading-app/1.0)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const json = await res.json();
  const q = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  const series = q.filter((x) => x != null);
  if (series.length < 21) throw new Error(`${symbol}: insufficient history`);
  return series;
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Number(x.toFixed(2));

/**
 * Real market breadth across the universe: how many names are advancing, how
 * many sit above their own 50-day average, and net new 52-week highs.
 */
async function computeBreadth() {
  const sample = SCREENER_UNIVERSE.slice(0, BREADTH_SAMPLE);
  const rows = await mapLimit(sample, 6, async (ticker) => {
    const bars = await getBars(ticker, 260);
    const px = closes(bars);
    const ma50 = sma(px, 50).at(-1);
    const last = px.at(-1);
    const prev = px.at(-2) ?? last;
    const high52 = Math.max(...px.slice(-252));
    const low52 = Math.min(...px.slice(-252));
    return {
      advancing: last > prev,
      aboveMa50: ma50 != null && last > ma50,
      newHigh: last >= high52 * 0.999,
      newLow: last <= low52 * 1.001,
    };
  });

  const ok = rows.filter((r) => r && !r.error);
  if (!ok.length) return null;

  const advancers = ok.filter((r) => r.advancing).length;
  const decliners = ok.length - advancers;
  const newHighs = ok.filter((r) => r.newHigh).length;
  const newLows = ok.filter((r) => r.newLow).length;

  return {
    sampleSize: ok.length,
    advancers,
    decliners,
    // Normalised to the same [-1, +1] shape the agent already expects.
    advanceDeclineSlope: round2((advancers - decliners) / ok.length),
    percentAboveMa50: round1((ok.filter((r) => r.aboveMa50).length / ok.length) * 100),
    newHighs,
    newLows,
    // Scaled to a comparable magnitude for the agent's grading bands.
    newHighsMinusLows: Math.round(((newHighs - newLows) / ok.length) * 300),
  };
}

/**
 * Returns the macro snapshot. Live when the price provider is live and the
 * fetches succeed; otherwise the generated snapshot, clearly marked.
 */
export async function getMacroSnapshot() {
  if (cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  if (provider() !== 'yahoo') {
    const value = { ...generateMacro(), source: 'MODELLED', sourceNote: 'Generated locally — the price provider is set to synthetic.' };
    cache = { at: Date.now(), value };
    return value;
  }

  try {
    const names = Object.keys(SERIES);
    const fetched = await mapLimit(names, 5, async (k) => [k, await fetchSeries(SERIES[k])]);
    const failures = fetched.filter((r) => r?.error);
    if (failures.length) throw new Error(failures[0].error);
    const s = Object.fromEntries(fetched);

    const latest = (k) => s[k].at(-1);
    const change20 = (k) => s[k].at(-1) - s[k].at(-21);
    const pctChange20 = (k) => (s[k].at(-1) / s[k].at(-21) - 1) * 100;

    const tnx = round2(latest('tnx'));
    const bill3m = round2(latest('bill3m'));

    // Credit stress proxy: high yield underperforming investment grade means
    // spreads are widening. Expressed so that a larger number is more stress,
    // matching the shape of an OAS series.
    const creditRelative = pctChange20('hyg') - pctChange20('lqd');
    const creditStressProxy = round2(-creditRelative);

    const breadth = await computeBreadth();

    const value = {
      source: 'LIVE',
      sourceNote: 'Yields, volatility, dollar and commodities are live from Yahoo Finance. Credit stress is an HYG/LQD proxy. Breadth is computed across the screening universe.',
      asOf: new Date().toISOString(),

      vix: round1(latest('vix')),
      vxn: round1(latest('vxn')),
      tnx,
      tnxChange20d: round2(change20('tnx')),
      bill3m,
      // Named for what it actually is.
      yieldCurve3m10s: round2(tnx - bill3m),
      dxy: round1(latest('dxy')),
      dxyChange20d: round1(change20('dxy')),
      oil: round1(latest('oil')),
      gold: Math.round(latest('gold')),
      creditStressProxy,
      hygChange20dPct: round2(pctChange20('hyg')),
      lqdChange20dPct: round2(pctChange20('lqd')),

      ...(breadth ?? { advanceDeclineSlope: 0, newHighsMinusLows: 0, sampleSize: 0 }),
      breadthSource: breadth ? 'DERIVED_FROM_UNIVERSE' : 'UNAVAILABLE',
    };

    cache = { at: Date.now(), value };
    return value;
  } catch (err) {
    console.warn(`[macro] live fetch failed (${err.message}) — using the generated snapshot`);
    const value = {
      ...generateMacro(),
      source: 'MODELLED',
      degraded: true,
      sourceNote: `Live macro unavailable (${err.message}); these values are generated.`,
    };
    cache = { at: Date.now(), value };
    return value;
  }
}

export function clearMacroCache() {
  cache = { at: 0, value: null };
}
