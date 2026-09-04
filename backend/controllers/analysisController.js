import { runAnalysis } from '../engine/ManagerOrchestrator.js';
import { walkForwardBacktest } from '../engine/BacktestEngine.js';
import { buildMarketContext, getQuote, getMacro, provider } from '../data/marketDataService.js';
import { listAgents, AGENT_IDS } from '../agents/index.js';
import { getPortfolio, saveAnalysisLog, listAnalysisLogs, listAgentRegistry, getPerformanceWeights } from '../data/store.js';
import { NASDAQ_QUICK_PICKS } from '../config/constants.js';

const TICKER_RE = /^[A-Z.\-]{1,10}$/;

function normaliseTicker(raw) {
  const t = String(raw || '').toUpperCase().trim();
  if (!TICKER_RE.test(t)) throw Object.assign(new Error(`Invalid ticker "${raw}"`), { status: 400 });
  return t;
}

/** Unknown agent ids are rejected outright rather than silently ignored. */
function resolveActiveAgents(raw) {
  if (raw === undefined || raw === null) return AGENT_IDS;
  const ids = Array.isArray(raw) ? raw : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !AGENT_IDS.includes(id));
  if (unknown.length) throw Object.assign(new Error(`Unknown agent id(s): ${unknown.join(', ')}`), { status: 400 });
  return ids;
}

export async function analyze(req, res, next) {
  try {
    const ticker = normaliseTicker(req.body?.ticker ?? req.query?.ticker);
    const activeAgentIds = resolveActiveAgents(req.body?.activeAgents ?? req.query?.activeAgents);
    const timeframe = req.body?.timeframe || '1D';

    const owner = req.user?.id ?? 'default-user';
    const [marketContext, portfolio, performanceWeights] = await Promise.all([
      buildMarketContext(ticker, { timeframe }),
      getPortfolio(owner),
      getPerformanceWeights(),
    ]);

    const decision = await runAnalysis({ ticker, activeAgentIds, marketContext, portfolio, performanceWeights, timeframe });

    // Persist for the audit trail, but never fail the request over logging.
    saveAnalysisLog(decision, owner).catch((e) => console.warn('[analysis] log write failed:', e.message));

    res.json({ ok: true, decision });
  } catch (err) { next(err); }
}

/** Batch analysis for the watchlist / screener view. */
export async function analyzeBatch(req, res, next) {
  try {
    const tickers = (req.body?.tickers || NASDAQ_QUICK_PICKS).slice(0, 25).map(normaliseTicker);
    const activeAgentIds = resolveActiveAgents(req.body?.activeAgents);
    const [portfolio, performanceWeights] = await Promise.all([
      getPortfolio(req.user?.id ?? 'default-user'), getPerformanceWeights(),
    ]);

    const results = await Promise.all(tickers.map(async (ticker) => {
      try {
        const marketContext = await buildMarketContext(ticker);
        const d = await runAnalysis({ ticker, activeAgentIds, marketContext, portfolio, performanceWeights });
        return {
          ticker,
          price: d.price,
          finalAction: d.finalAction,
          compositeScore: d.compositeScore,
          confidence: d.confidence,
          probabilityOfProfit: d.probabilityOfProfit,
          stage: d.agentBreakdown.find((a) => a.agentId === 'Weinstein_Stage_Agent')?.payload?.stage ?? null,
          rsRating: d.agentBreakdown.find((a) => a.agentId === 'Relative_Strength_Agent')?.payload?.rsRating ?? null,
          vetoes: d.vetoesTriggered.map((v) => v.code),
          suggestedShares: d.positionSizing?.suggestedShares ?? 0,
        };
      } catch (err) {
        return { ticker, error: err.message };
      }
    }));

    res.json({ ok: true, count: results.length, results });
  } catch (err) { next(err); }
}

export async function getChart(req, res, next) {
  try {
    const ticker = normaliseTicker(req.params.ticker);
    const days = Math.min(Number(req.query.days) || 400, 1500);
    const ctx = await buildMarketContext(ticker);
    const bars = ctx.bars.slice(-days);

    // Overlays the chart component draws: 30-week MA (Weinstein), 50-day, and
    // the current triple-barrier levels.
    const { sma, closes, toWeekly } = await import('../lib/indicators.js');
    const px = closes(ctx.bars);
    const ma50 = sma(px, 50);
    const ma150 = sma(px, 150);
    const weekly = toWeekly(ctx.bars);
    const ma30w = sma(closes(weekly), 30);

    res.json({
      ok: true,
      ticker,
      provider: ctx.provider,
      bars: bars.map((b, i) => {
        const gi = ctx.bars.length - bars.length + i;
        return { ...b, ma50: ma50[gi] ? Number(ma50[gi].toFixed(2)) : null, ma150: ma150[gi] ? Number(ma150[gi].toFixed(2)) : null };
      }),
      weekly: weekly.slice(-120).map((w, i) => {
        const gi = weekly.length - Math.min(120, weekly.length) + i;
        return { ...w, ma30w: ma30w[gi] ? Number(ma30w[gi].toFixed(2)) : null };
      }),
    });
  } catch (err) { next(err); }
}

export async function getAgentRegistry(req, res, next) {
  try {
    const persisted = await listAgentRegistry();
    const defs = listAgents();
    const byId = Object.fromEntries(persisted.map((p) => [p.agentId, p]));
    res.json({
      ok: true,
      count: defs.length,
      agents: defs.map((d) => ({ ...d, performance: byId[d.agentId]?.performance ?? null })),
    });
  } catch (err) { next(err); }
}

export async function getLogs(req, res, next) {
  try {
    res.json({ ok: true, logs: await listAnalysisLogs({ ticker: req.query.ticker, limit: Number(req.query.limit) || 25 }) });
  } catch (err) { next(err); }
}

export async function backtest(req, res, next) {
  try {
    const ticker = normaliseTicker(req.body?.ticker ?? req.query?.ticker);
    const permutations = Math.min(Number(req.body?.permutations ?? req.query?.permutations ?? 200), 500);
    const ctx = await buildMarketContext(ticker);
    res.json({ ok: true, backtest: walkForwardBacktest(ctx, { permutations }) });
  } catch (err) { next(err); }
}

export async function getMarketOverview(req, res, next) {
  try {
    const tickers = req.query.tickers ? String(req.query.tickers).split(',').map(normaliseTicker) : NASDAQ_QUICK_PICKS;
    const { getProvenance } = await import('../data/marketDataService.js');
    const [quotes, macro] = await Promise.all([
      Promise.all(tickers.map((t) => getQuote(t).catch(() => null))),
      getMacro(),
    ]);
    const live = quotes.filter(Boolean).map((q) => ({ ...q, source: getProvenance(q.ticker)?.live ? 'LIVE' : 'MODELLED' }));
    res.json({
      ok: true,
      provider: provider(),
      macro,
      macroSource: macro.source ?? 'MODELLED',
      macroNote: macro.sourceNote,
      quotes: live,
    });
  } catch (err) { next(err); }
}
