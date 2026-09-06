// Market data facade.
//
// Two providers: `synthetic` (default — deterministic, offline, no API key) and
// `yahoo` (live daily bars from the public chart endpoint). Yahoo failures fall
// back to synthetic per-ticker so a network problem degrades one symbol instead
// of taking the analysis engine down. Fundamentals / options / news are always
// modelled locally — those feeds require paid entitlements, and the agents care
// about the shape of the inputs, not their provenance.

import {
  generateBars, generateFundamentals, generateOptionsChainSummary, generateNews,
} from './syntheticMarket.js';
import { BENCHMARK, BARRIERS, HISTORY_MAX_DAYS } from '../config/constants.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map();

function cached(key, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = producer();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function cachedAsync(key, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await producer();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Longest daily history available, for backtesting and model fitting. */
export async function getFullHistory(ticker) {
  return getBars(ticker, HISTORY_MAX_DAYS);
}

export function provider() {
  return (process.env.MARKET_DATA_PROVIDER || 'synthetic').toLowerCase();
}

async function fetchYahooBars(ticker, days) {
  // Explicit period1/period2 rather than `range`: `range=max` silently drops to
  // a coarser interval (a few hundred bars spanning decades), and `range` caps
  // out at 10y. Timestamps return true daily bars for as far back as requested,
  // which a position horizon needs.
  const now = Math.floor(Date.now() / 1000);
  // 365/252 converts trading days to calendar days, plus a margin for holidays.
  const lookbackSeconds = Math.ceil(days * (365 / 252) * 1.05) * 24 * 3600;
  const period1 = now - lookbackSeconds;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=${period1}&period2=${now}&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; trading-app/1.0)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('yahoo: empty result');

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  const r2 = (x) => Math.round(x * 100) / 100; // Yahoo returns full float precision
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null || q.open?.[i] == null) continue;
    bars.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: r2(q.open[i]),
      high: r2(q.high[i]),
      low: r2(q.low[i]),
      close: r2(q.close[i]),
      volume: q.volume[i] ?? 0,
    });
  }
  // A recent IPO genuinely has less history than requested; that is not an
  // error, but too little to analyse is.
  if (bars.length < 260) throw new Error(`yahoo: only ${bars.length} bars available, need at least 260`);
  return bars.slice(-days);
}

// Per-symbol record of where the last set of bars actually came from, so a
// degraded fetch can never masquerade as live data downstream.
const provenance = new Map();

export function getProvenance(symbol) {
  return provenance.get(String(symbol).toUpperCase()) || null;
}

/**
 * Whether a failed live fetch may fall back to generated data. Off by default:
 * once an operator has asked for real prices, silently substituting invented
 * ones is worse than failing loudly. Set ALLOW_SYNTHETIC_FALLBACK=true to trade
 * that strictness for resilience — the fallback is then flagged as DEGRADED.
 */
function fallbackAllowed() {
  return String(process.env.ALLOW_SYNTHETIC_FALLBACK || 'false').toLowerCase() === 'true';
}

/** Daily OHLCV bars, newest last. */
export async function getBars(ticker, days = BARRIERS.analysisDays) {
  const symbol = ticker.toUpperCase();
  return cachedAsync(`bars:${symbol}:${days}:${provider()}`, async () => {
    if (provider() === 'yahoo') {
      try {
        const bars = await fetchYahooBars(symbol, days);
        provenance.set(symbol, { source: 'yahoo', live: true, asOf: bars.at(-1).date, fetchedAt: new Date().toISOString() });
        return bars;
      } catch (err) {
        if (!fallbackAllowed()) {
          provenance.set(symbol, { source: 'none', live: false, error: err.message });
          throw Object.assign(
            new Error(`Live market data unavailable for ${symbol} (${err.message}). Check the symbol, or set ALLOW_SYNTHETIC_FALLBACK=true to allow generated data.`),
            { status: 502 },
          );
        }
        console.warn(`[data] yahoo failed for ${symbol} (${err.message}) — DEGRADED to synthetic series`);
        provenance.set(symbol, { source: 'synthetic', live: false, degraded: true, error: err.message });
        return generateBars(symbol, days);
      }
    }
    provenance.set(symbol, { source: 'synthetic', live: false, degraded: false });
    return generateBars(symbol, days);
  });
}

export async function getQuote(ticker) {
  const bars = await getBars(ticker, 260);
  const last = bars.at(-1);
  const prev = bars.at(-2) ?? last;
  return {
    ticker: ticker.toUpperCase(),
    price: last.close,
    change: Number((last.close - prev.close).toFixed(2)),
    changePercent: Number((((last.close - prev.close) / prev.close) * 100).toFixed(2)),
    volume: last.volume,
    date: last.date,
  };
}

export async function getBenchmarkBars(days = BARRIERS.analysisDays) {
  return getBars(BENCHMARK, days);
}

export function getFundamentals(ticker, bars) {
  return cached(`fund:${ticker}`, () => generateFundamentals(ticker.toUpperCase(), bars));
}

export function getOptions(ticker, price, bars) {
  return cached(`opt:${ticker}:${Math.round(price)}`, () => generateOptionsChainSummary(ticker.toUpperCase(), price, bars));
}

export function getNews(ticker) {
  return cached(`news:${ticker}`, () => generateNews(ticker.toUpperCase()));
}

/**
 * Macro is fetched live where possible (see data/macroService.js). Imported
 * lazily to keep the module graph acyclic — macroService reads bars from here.
 */
export async function getMacro() {
  const { getMacroSnapshot } = await import('./macroService.js');
  return getMacroSnapshot();
}

/**
 * Assembles the single context object every agent receives. Built once per
 * analysis run so the 11 agents share one consistent snapshot of the world.
 */
export async function buildMarketContext(ticker, { timeframe = '1D', days = BARRIERS.analysisDays } = {}) {
  const symbol = ticker.toUpperCase();
  const [bars, benchmarkBars, macro] = await Promise.all([
    getBars(symbol, days), getBenchmarkBars(days), getMacro(),
  ]);
  const price = bars.at(-1).close;

  const priceSource = getProvenance(symbol);
  const benchSource = getProvenance(BENCHMARK);

  return {
    ticker: symbol,
    timeframe,
    bars,
    benchmarkBars,
    price,
    asOf: bars.at(-1).date,
    fundamentals: getFundamentals(symbol, bars),
    options: getOptions(symbol, price, bars),
    news: getNews(symbol),
    macro,
    provider: provider(),
    // Explicit provenance per feed. Price/volume can be live; the remaining
    // feeds are modelled locally regardless of provider, and saying so here is
    // what stops a modelled gamma level being read as an observed one.
    dataSources: {
      priceVolume: priceSource?.live ? 'LIVE' : 'MODELLED',
      priceVolumeDetail: priceSource,
      benchmark: benchSource?.live ? 'LIVE' : 'MODELLED',
      fundamentals: 'MODELLED',
      options: 'MODELLED',
      news: 'MODELLED',
      macro: macro.source === 'LIVE' ? 'LIVE' : 'MODELLED',
      macroNote: macro.sourceNote,
      degraded: Boolean(priceSource?.degraded || benchSource?.degraded),
    },
  };
}
