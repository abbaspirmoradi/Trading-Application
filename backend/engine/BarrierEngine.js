// Entry resolution and barrier construction.
//
// Order matters: the entry price must be settled before the barriers, because a
// stop, a target and a reward:risk ratio only mean anything relative to the
// price you actually get filled at. Computing them from spot and then entering
// on a breakout above spot produces numbers that describe a different trade.

import { atr, sma, toWeekly, closes } from '../lib/indicators.js';
import { buildBarriers } from '../agents/RiskAgents.js';
import { BARRIERS } from '../config/constants.js';

/**
 * Where would this trade actually be entered?
 *   STOP_LIMIT — a breakout trigger sits ahead of spot and within reach
 *   LIMIT      — price is already through the trigger, so enter at market
 *   WATCH      — the trigger is too far away to act on today
 */
export function resolveEntry(ctx, direction, agentResults) {
  const price = ctx.price;
  const isLong = direction >= 0;
  const pattern = agentResults.find((r) => r.agentId === 'Chart_Pattern_Agent')?.payload;

  const triggerLevel = pattern?.direction === (isLong ? 'LONG' : 'SHORT') ? pattern.breakoutLevel : null;
  const ahead = triggerLevel != null && (isLong ? triggerLevel > price : triggerLevel < price);

  if (!ahead) {
    return { entryPrice: price, mode: 'LIMIT', triggerLevel, distancePct: 0, pattern };
  }

  const distancePct = Math.abs((triggerLevel - price) / price) * 100;
  if (distancePct > BARRIERS.maxEntryDistancePct) {
    return { entryPrice: price, mode: 'WATCH', triggerLevel, distancePct, pattern };
  }
  return { entryPrice: triggerLevel, mode: 'STOP_LIMIT', triggerLevel, distancePct, pattern };
}

/**
 * Barriers for the consensus direction, anchored at `entryPrice` (the price the
 * order would actually fill at) rather than at spot.
 */
export function computeExecutionBarriers(ctx, direction, agentResults, entryPrice = null) {
  const bars = ctx.bars;
  const atrNow = atr(bars, BARRIERS.atrPeriod).at(-1);
  if (!atrNow) return null;

  const ma30w = sma(closes(toWeekly(bars)), 30).at(-1) ?? null;
  const swingLow = Math.min(...bars.slice(-20).map((b) => b.low));
  const swingHigh = Math.max(...bars.slice(-20).map((b) => b.high));

  const pattern = agentResults.find((r) => r.agentId === 'Chart_Pattern_Agent')?.payload;

  return buildBarriers({
    price: entryPrice ?? ctx.price,
    atrNow,
    ma30w,
    swingLow,
    swingHigh,
    direction: direction >= 0 ? 'LONG' : 'SHORT',
    patternInvalidation: pattern?.invalidation ?? null,
  });
}

export { buildBarriers };
