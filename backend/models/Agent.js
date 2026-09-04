import mongoose from 'mongoose';

/**
 * Persisted agent registry entry. Holds the rolling performance statistics that
 * drive dynamic consensus weighting: an agent whose recent calls have been
 * profitable and well-calibrated earns a larger vote.
 */
const AgentSchema = new mongoose.Schema({
  agentId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  cluster: { type: String, required: true },
  description: { type: String, default: '' },
  enabledByDefault: { type: Boolean, default: true },
  baseWeight: { type: Number, default: 1.0 },

  performance: {
    // 30-day rolling Sharpe of the trades this agent voted for.
    rollingSharpe30d: { type: Number, default: 0 },
    // Brier score of its directional calls; lower is better-calibrated.
    brierScore: { type: Number, default: 0.25 },
    callsMade: { type: Number, default: 0 },
    callsCorrect: { type: Number, default: 0 },
    lastEvaluatedAt: { type: Date },
  },
}, { timestamps: true });

/**
 * Dynamic weight = base x Sharpe factor x calibration factor.
 * Clamped to [0.4, 1.8] so a hot streak cannot let one agent dominate the vote
 * and a cold streak cannot silence it entirely.
 */
AgentSchema.methods.dynamicWeight = function dynamicWeight() {
  const sharpe = this.performance?.rollingSharpe30d ?? 0;
  const brier = this.performance?.brierScore ?? 0.25;
  const sharpeFactor = 1 + Math.max(-0.5, Math.min(0.5, sharpe / 4));
  const calibrationFactor = 1 + Math.max(-0.4, Math.min(0.4, (0.25 - brier) * 2));
  const n = this.performance?.callsMade ?? 0;
  // Shrink toward 1.0 until there is a meaningful sample of calls.
  const credibility = Math.min(1, n / 30);
  const raw = sharpeFactor * calibrationFactor;
  const shrunk = 1 + (raw - 1) * credibility;
  return Math.max(0.4, Math.min(1.8, shrunk));
};

AgentSchema.set('toJSON', { virtuals: true });

export default mongoose.models.Agent || mongoose.model('Agent', AgentSchema);
