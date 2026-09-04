import { RISK } from '../config/constants.js';
import { clamp } from '../lib/stats.js';

/**
 * Fractional Kelly position sizing.
 *
 *   f* = (p(b+1) - 1) / b        p = win probability, b = payoff ratio
 *
 * Full Kelly maximises long-run growth but assumes p and b are known exactly.
 * They are not — they are estimates from a noisy meta-model — so the result is
 * scaled by a conservative fraction (quarter-Kelly by default) and then passed
 * through three hard caps:
 *
 *   1. the per-trade risk ceiling (~1% of equity),
 *   2. the absolute position ceiling (5% of equity),
 *   3. whatever heat budget the portfolio has left.
 *
 * Whichever binds first wins. Kelly proposes; the risk limits dispose.
 */
export function computeKellySize({
  winProbability,
  payoffRatio,
  equity,
  price,
  riskPerShare,
  maxRiskDollar,
  maxPositionDollar,
  remainingHeatPct = 100,
  kellyFraction = RISK.kellyFraction,
}) {
  const p = clamp(winProbability, 0.01, 0.99);
  const b = Math.max(payoffRatio, 0.01);

  const fullKelly = (p * (b + 1) - 1) / b;
  // Reported as-is (floored at zero): the 5% position cap is enforced below via
  // sharesByCap, so clamping here would misreport what Kelly actually proposed.
  const kellyFractionOfEquity = clamp(fullKelly * kellyFraction, 0, 1);

  const notes = [];
  if (fullKelly <= 0) notes.push('Kelly criterion is negative — the edge does not justify any position at these odds');

  // Risk-based sizing: shares such that (entry - stop) x shares <= max risk.
  const heatCapDollar = equity * (Math.min(remainingHeatPct, RISK.maxRiskPerTradePct) / 100);
  const riskBudget = Math.min(maxRiskDollar, heatCapDollar);
  const sharesByRisk = riskPerShare > 0 ? Math.floor(riskBudget / riskPerShare) : 0;

  // Kelly-based sizing: allocate f* of equity as notional.
  const sharesByKelly = price > 0 ? Math.floor((kellyFractionOfEquity * equity) / price) : 0;

  // Hard position cap.
  const sharesByCap = price > 0 ? Math.floor(maxPositionDollar / price) : 0;

  const shares = Math.max(0, Math.min(sharesByRisk, sharesByKelly, sharesByCap));

  let binding = 'kelly';
  if (shares === sharesByRisk && sharesByRisk <= sharesByKelly && sharesByRisk <= sharesByCap) binding = 'per-trade risk limit';
  else if (shares === sharesByCap && sharesByCap <= sharesByKelly) binding = `${RISK.hardMaxPositionPct}% position cap`;
  else binding = `fractional Kelly (${kellyFraction}x)`;

  const allocationDollar = shares * price;
  const riskDollar = shares * riskPerShare;

  notes.push(`Full Kelly ${(fullKelly * 100).toFixed(1)}% of equity at p=${p.toFixed(3)}, b=${b.toFixed(2)}; ${kellyFraction}x fractional Kelly = ${(kellyFractionOfEquity * 100).toFixed(2)}%`);
  notes.push(`Binding constraint: ${binding}`);

  return {
    fullKelly: Number(fullKelly.toFixed(4)),
    fractionalKelly: Number(kellyFractionOfEquity.toFixed(4)),
    kellyFraction,
    suggestedShares: shares,
    allocationDollar: Number(allocationDollar.toFixed(2)),
    portfolioPercent: Number(((allocationDollar / equity) * 100).toFixed(2)),
    maxRiskDollar: Number(riskBudget.toFixed(2)),
    actualRiskDollar: Number(riskDollar.toFixed(2)),
    actualRiskPercent: Number(((riskDollar / equity) * 100).toFixed(3)),
    bindingConstraint: binding,
    sizingNotes: notes,
    sharesByRisk,
    sharesByKelly,
    sharesByCap,
  };
}
