// Hard veto rules.
//
// Vetoes are deliberately NOT votes. A veto cannot be outweighed by enthusiasm
// elsewhere in the system: no number of bullish agents makes buying a Stage 4
// downtrend acceptable, and no setup quality makes breaching the risk limit
// acceptable. BLOCK stops the trade outright; DOWNGRADE lets it through at a
// reduced size.

import { RISK, BREAKOUT, BARRIERS } from '../config/constants.js';

export const VETO_SEVERITY = { BLOCK: 'BLOCK', DOWNGRADE: 'DOWNGRADE' };

/**
 * @param {Array} results  agent outputs from the active agents only
 * @param {number} direction  +1 long, -1 short, 0 flat
 * @param {object} barriers  execution barriers for the consensus direction
 */
export function evaluateVetoes(results, direction, barriers) {
  const byId = Object.fromEntries(results.map((r) => [r.agentId, r]));
  const vetoes = [];

  const weinstein = byId.Weinstein_Stage_Agent;
  const volume = byId.Volume_OrderFlow_Agent;
  const risk = byId.Portfolio_Risk_Agent;
  const macro = byId.Intermarket_Macro_Agent;

  // 1. Stage 4 veto — the single most important rule in the system.
  if (weinstein?.status === 'COMPLETE' && direction > 0) {
    const stage = weinstein.payload.stage;
    if (stage === 4) {
      vetoes.push({
        code: 'STAGE_4_VETO',
        severity: VETO_SEVERITY.BLOCK,
        agentId: weinstein.agentId,
        message: 'Weinstein Stage 4 decline: long entries are blocked regardless of every other agent score. Falling 30-week MA with price beneath it.',
        sizeMultiplier: 0,
      });
    } else if (stage === 3) {
      vetoes.push({
        code: 'STAGE_3_DISTRIBUTION',
        severity: VETO_SEVERITY.DOWNGRADE,
        agentId: weinstein.agentId,
        message: 'Stage 3 topping/distribution: no new long exposure, existing positions should be trailing tighter stops.',
        sizeMultiplier: 0.35,
      });
    }
  }

  // Mirror rule for shorts: never short a healthy Stage 2 advance.
  if (weinstein?.status === 'COMPLETE' && direction < 0 && weinstein.payload.stage === 2) {
    vetoes.push({
      code: 'STAGE_2_SHORT_VETO',
      severity: VETO_SEVERITY.BLOCK,
      agentId: weinstein.agentId,
      message: 'Shorting a confirmed Stage 2 advance with a rising 30-week MA is blocked.',
      sizeMultiplier: 0,
    });
  }

  // 2. Volume veto — a breakout without institutional volume is a trap.
  if (volume?.status === 'COMPLETE' && direction > 0) {
    const { hasBreakout, volumeConfirmed, volumeRatio } = volume.payload;
    if (hasBreakout && !volumeConfirmed) {
      vetoes.push({
        code: 'VOLUME_UNCONFIRMED',
        severity: VETO_SEVERITY.DOWNGRADE,
        agentId: volume.agentId,
        message: `Breakout occurred on only ${volumeRatio.toFixed(2)}x average volume, below the ${BREAKOUT.volumeConfirmMultiple}x requirement — position size halved and the trade flagged high-risk.`,
        sizeMultiplier: 0.5,
      });
    }
  }

  // 3. Risk vetoes — the gatekeeper's word is final.
  if (risk?.status === 'COMPLETE') {
    if (risk.payload.heatBreach) {
      vetoes.push({
        code: 'PORTFOLIO_HEAT_BREACH',
        severity: VETO_SEVERITY.BLOCK,
        agentId: risk.agentId,
        message: `Portfolio heat ${risk.payload.portfolioHeatPct.toFixed(2)}% has reached the ${RISK.maxPortfolioHeatPct}% ceiling. No new risk may be added.`,
        sizeMultiplier: 0,
      });
    }
    if (risk.payload.positionCapExhausted) {
      vetoes.push({
        code: 'POSITION_CAP_REACHED',
        severity: VETO_SEVERITY.BLOCK,
        agentId: risk.agentId,
        message: `The existing holding already fills the ${RISK.hardMaxPositionPct}% single-idea ceiling. Conviction does not entitle a position to more than that — no add permitted.`,
        sizeMultiplier: 0,
      });
    }
    if (risk.payload.correlationBreach) {
      vetoes.push({
        code: 'CORRELATION_OVER_CONCENTRATION',
        severity: VETO_SEVERITY.BLOCK,
        agentId: risk.agentId,
        message: `Correlation ${risk.payload.maxCorrelation.toFixed(2)} to an existing holding exceeds the ${RISK.correlationVetoThreshold} limit — this would double an existing risk factor rather than add a new one.`,
        sizeMultiplier: 0,
      });
    }
  }

  // 4. Intermarket threat radar — de-leverage, do not necessarily stand down.
  if (macro?.status === 'COMPLETE' && macro.payload.threatRadar && direction > 0) {
    vetoes.push({
      code: 'INTERMARKET_THREAT_RADAR',
      severity: VETO_SEVERITY.DOWNGRADE,
      agentId: macro.agentId,
      message: 'Yields spiking with VIX above 25: high-beta growth exposure is being dialled down system-wide.',
      sizeMultiplier: 0.5,
    });
  }

  // 5. Reward:risk floor — a good idea at a bad price is a bad trade.
  if (barriers && direction !== 0) {
    if (barriers.riskRewardRatio < 1.0) {
      vetoes.push({
        code: 'REWARD_RISK_FLOOR',
        severity: VETO_SEVERITY.BLOCK,
        agentId: 'Triple_Barrier_Exit_Agent',
        message: `Reward:risk of ${barriers.riskRewardRatio.toFixed(2)}:1 is below 1:1 — the entry is too extended from its stop to be worth taking.`,
        sizeMultiplier: 0,
      });
    } else if (barriers.riskRewardRatio < BARRIERS.minRewardRisk) {
      vetoes.push({
        code: 'REWARD_RISK_SUBOPTIMAL',
        severity: VETO_SEVERITY.DOWNGRADE,
        agentId: 'Triple_Barrier_Exit_Agent',
        message: `Reward:risk ${barriers.riskRewardRatio.toFixed(2)}:1 is below the ${BARRIERS.minRewardRisk}:1 target — reduced size, or wait for a pullback closer to support.`,
        sizeMultiplier: 0.6,
      });
    }
  }

  const blocked = vetoes.some((v) => v.severity === VETO_SEVERITY.BLOCK);
  const sizeMultiplier = blocked ? 0 : vetoes.reduce((m, v) => m * v.sizeMultiplier, 1);

  return { vetoes, blocked, sizeMultiplier };
}
