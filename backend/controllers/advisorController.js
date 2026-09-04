import { advisePortfolio } from '../engine/PortfolioAdvisor.js';
import { screenUniverse } from '../engine/Screener.js';
import { getPortfolio, getPerformanceWeights } from '../data/store.js';
import { getQuote } from '../data/marketDataService.js';
import { AGENT_IDS } from '../agents/index.js';
import { SCREENER_UNIVERSE } from '../config/constants.js';

function resolveAgents(raw) {
  if (!raw) return AGENT_IDS;
  const ids = Array.isArray(raw) ? raw : String(raw).split(',');
  const unknown = ids.filter((id) => !AGENT_IDS.includes(id));
  if (unknown.length) throw Object.assign(new Error(`Unknown agent id(s): ${unknown.join(', ')}`), { status: 400 });
  return ids;
}

/** Full review of the caller's holdings. Requires authentication. */
export async function reviewPortfolio(req, res, next) {
  try {
    const owner = req.user.id;
    const activeAgentIds = resolveAgents(req.body?.activeAgents ?? req.query?.activeAgents);

    // Mark to market first so every verdict is based on current prices.
    const pf = await getPortfolio(owner);
    const tickers = [...new Set((pf.positions || []).map((p) => p.ticker))];
    const quotes = await Promise.all(tickers.map((t) => getQuote(t).catch(() => null)));
    const priceBy = Object.fromEntries(quotes.filter(Boolean).map((q) => [q.ticker, q.price]));
    const marked = {
      ...pf,
      positions: (pf.positions || []).map((p) => ({ ...p, currentPrice: priceBy[p.ticker] ?? p.currentPrice ?? p.entryPrice })),
    };

    const performanceWeights = await getPerformanceWeights();
    const review = await advisePortfolio({ portfolio: marked, activeAgentIds, performanceWeights });
    res.json({ ok: true, review });
  } catch (err) { next(err); }
}

/** Daily ranked buy candidates across the screening universe. */
export async function dailyPicks(req, res, next) {
  try {
    const activeAgentIds = resolveAgents(req.body?.activeAgents ?? req.query?.activeAgents);
    const limit = Math.min(Number(req.body?.limit ?? req.query?.limit ?? 10), 25);
    const force = String(req.query?.refresh ?? req.body?.refresh ?? '') === 'true';

    const requested = req.body?.universe;
    const universe = Array.isArray(requested) && requested.length
      ? requested.map((t) => String(t).toUpperCase()).slice(0, 60)
      : SCREENER_UNIVERSE;

    // Sizing is relative to the caller's portfolio when signed in.
    const portfolio = req.user
      ? await getPortfolio(req.user.id)
      : { equity: 100000, cash: 100000, positions: [] };

    const performanceWeights = await getPerformanceWeights();
    const screen = await screenUniverse({ universe, activeAgentIds, portfolio, performanceWeights, limit, force });
    res.json({ ok: true, screen });
  } catch (err) { next(err); }
}
