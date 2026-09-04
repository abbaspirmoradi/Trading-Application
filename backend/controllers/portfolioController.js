import { getPortfolio, savePortfolio, addPosition, removePosition, markToMarket, updatePosition } from '../data/store.js';
import { getQuote, getBars } from '../data/marketDataService.js';
import { correlation, clamp } from '../lib/stats.js';
import { closes } from '../lib/indicators.js';
import { RISK } from '../config/constants.js';
import { publish, TOPICS } from '../bus/eventBus.js';

// Every handler below sits behind requireAuth, so req.user.id is always set.
const ownerOf = (req) => req.user.id;

export async function fetchPortfolio(req, res, next) {
  try {
    const pf = await getPortfolio(ownerOf(req));
    const tickers = [...new Set(pf.positions.map((p) => p.ticker))];
    const quotes = await Promise.all(tickers.map((t) => getQuote(t).catch(() => null)));
    const marked = await markToMarket(quotes.filter(Boolean), ownerOf(req));
    res.json({ ok: true, portfolio: marked });
  } catch (err) { next(err); }
}

export async function updatePortfolio(req, res, next) {
  try {
    const allowed = ['name', 'equity', 'cash', 'watchlist', 'riskSettings', 'startingEquity'];
    const update = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    const pf = await savePortfolio(update, ownerOf(req));
    await publish(TOPICS.PORTFOLIO_UPDATED, { equity: pf.equity });
    res.json({ ok: true, portfolio: pf });
  } catch (err) { next(err); }
}

export async function createPosition(req, res, next) {
  try {
    const { ticker, shares, entryPrice, stopPrice, side = 'LONG', profitTarget, timeBarrier, thesis } = req.body || {};
    if (!ticker || !shares || !entryPrice || !stopPrice) {
      return res.status(400).json({ ok: false, error: 'ticker, shares, entryPrice and stopPrice are required' });
    }
    if (side === 'LONG' && stopPrice >= entryPrice) {
      return res.status(400).json({ ok: false, error: 'A long stop must sit below the entry price' });
    }
    if (side === 'SHORT' && stopPrice <= entryPrice) {
      return res.status(400).json({ ok: false, error: 'A short stop must sit above the entry price' });
    }

    // Enforce the per-trade risk ceiling at the point of entry, not just in the
    // recommendation — the API must not accept a position the engine would
    // never have proposed.
    const pf = await getPortfolio(ownerOf(req));
    const riskDollar = Math.abs(entryPrice - stopPrice) * shares;
    const riskPct = (riskDollar / pf.equity) * 100;
    if (riskPct > RISK.maxRiskPerTradePct * 2) {
      return res.status(422).json({
        ok: false,
        error: `Position risks ${riskPct.toFixed(2)}% of equity, exceeding the ${(RISK.maxRiskPerTradePct * 2).toFixed(1)}% hard ceiling`,
      });
    }

    const quote = await getQuote(ticker).catch(() => null);
    const updated = await addPosition({
      ticker: ticker.toUpperCase(), side, shares, entryPrice, stopPrice,
      profitTarget, timeBarrier, thesis, currentPrice: quote?.price ?? entryPrice,
    }, ownerOf(req));
    await publish(TOPICS.PORTFOLIO_UPDATED, { ticker, action: 'POSITION_OPENED' });
    res.status(201).json({ ok: true, portfolio: updated });
  } catch (err) { next(err); }
}

export async function deletePosition(req, res, next) {
  try {
    const updated = await removePosition(req.params.id, ownerOf(req));
    if (!updated) return res.status(404).json({ ok: false, error: 'Portfolio not found' });
    await publish(TOPICS.PORTFOLIO_UPDATED, { action: 'POSITION_CLOSED' });
    res.json({ ok: true, portfolio: updated });
  } catch (err) { next(err); }
}

/** Amend a position — used by the advisor's "raise your stop" and trim actions. */
export async function patchPosition(req, res, next) {
  try {
    const { shares, stopPrice, profitTarget, thesis } = req.body || {};
    const patch = {};
    if (shares != null) {
      if (!(Number(shares) > 0)) return res.status(400).json({ ok: false, error: 'shares must be greater than zero' });
      patch.shares = Number(shares);
    }
    if (stopPrice != null) patch.stopPrice = Number(stopPrice);
    if (profitTarget != null) patch.profitTarget = Number(profitTarget);
    if (thesis != null) patch.thesis = String(thesis).slice(0, 500);
    if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'Nothing to update' });

    const updated = await updatePosition(req.params.id, patch, ownerOf(req));
    if (!updated) return res.status(404).json({ ok: false, error: 'Position not found' });
    await publish(TOPICS.PORTFOLIO_UPDATED, { action: 'POSITION_AMENDED' });
    res.json({ ok: true, portfolio: updated });
  } catch (err) { next(err); }
}

/**
 * Portfolio stress test: the N x N correlation matrix across holdings plus a
 * set of scenario shocks. Correlation is the number that decides whether a
 * portfolio of eight names is really eight bets or one bet held eight times.
 */
export async function stressTest(req, res, next) {
  try {
    const pf = await getPortfolio(ownerOf(req));
    const positions = pf.positions || [];
    if (!positions.length) {
      return res.json({ ok: true, stress: { positions: 0, message: 'No open positions to stress test.', matrix: [], scenarios: [] } });
    }

    const series = {};
    await Promise.all(positions.map(async (p) => {
      try {
        const bars = await getBars(p.ticker, 200);
        const px = closes(bars);
        const r = [];
        for (let i = 1; i < px.length; i++) r.push(px[i] / px[i - 1] - 1);
        series[p.ticker] = r.slice(-120);
      } catch { series[p.ticker] = null; }
    }));

    const tickers = positions.map((p) => p.ticker);
    const matrix = tickers.map((a) => ({
      ticker: a,
      correlations: tickers.map((b) => ({
        ticker: b,
        value: a === b ? 1 : Number((series[a] && series[b] ? correlation(series[a], series[b]) : 0).toFixed(3)),
      })),
    }));

    const offDiagonal = [];
    for (let i = 0; i < tickers.length; i++) {
      for (let j = i + 1; j < tickers.length; j++) {
        offDiagonal.push({ pair: [tickers[i], tickers[j]], value: matrix[i].correlations[j].value });
      }
    }
    offDiagonal.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const avgCorrelation = offDiagonal.length ? offDiagonal.reduce((a, x) => a + x.value, 0) / offDiagonal.length : 0;

    // Scenario shocks. Positions are shocked by beta-scaled moves; correlated
    // books lose far more than the naive sum suggests.
    const marketValue = positions.reduce((a, p) => a + (p.currentPrice ?? p.entryPrice) * p.shares, 0);
    const scenarios = [
      { name: 'NASDAQ -5% single session', shock: -0.05, betaMultiplier: 1.3 },
      { name: 'NASDAQ -10% correction', shock: -0.10, betaMultiplier: 1.3 },
      { name: 'Rate shock: 10Y +50bp', shock: -0.07, betaMultiplier: 1.5 },
      { name: 'Risk-off: VIX to 35', shock: -0.12, betaMultiplier: 1.4 },
    ].map((s) => {
      const loss = marketValue * s.shock * s.betaMultiplier;
      const stoppedOut = positions.filter((p) => {
        const px = (p.currentPrice ?? p.entryPrice) * (1 + s.shock * s.betaMultiplier);
        return p.side === 'SHORT' ? px >= p.stopPrice : px <= p.stopPrice;
      });
      return {
        ...s,
        estimatedPnl: Number(loss.toFixed(2)),
        equityAfter: Number((pf.equity + loss).toFixed(2)),
        drawdownPct: Number(((-loss / pf.equity) * 100).toFixed(2)),
        positionsStoppedOut: stoppedOut.map((p) => p.ticker),
      };
    });

    const heat = pf.portfolioHeatPct ?? 0;
    res.json({
      ok: true,
      stress: {
        positions: positions.length,
        equity: pf.equity,
        marketValue: Number(marketValue.toFixed(2)),
        grossExposurePct: Number(((marketValue / pf.equity) * 100).toFixed(1)),
        portfolioHeatPct: Number(heat.toFixed(2)),
        heatLimitPct: RISK.maxPortfolioHeatPct,
        heatUtilisationPct: Number(clamp((heat / RISK.maxPortfolioHeatPct) * 100, 0, 999).toFixed(1)),
        avgCorrelation: Number(avgCorrelation.toFixed(3)),
        highestCorrelationPair: offDiagonal[0] ?? null,
        concentrationWarning: offDiagonal.some((x) => Math.abs(x.value) > RISK.correlationVetoThreshold)
          ? `Correlated cluster detected above the ${RISK.correlationVetoThreshold} limit — these positions will move as one in a drawdown.`
          : null,
        matrix,
        scenarios,
      },
    });
  } catch (err) { next(err); }
}
