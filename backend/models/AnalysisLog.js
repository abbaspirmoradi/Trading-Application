import mongoose from 'mongoose';

/**
 * An immutable record of every decision the orchestrator produced. This is the
 * audit trail: it is what makes after-the-fact agent performance attribution
 * (and therefore dynamic weighting) possible, and what a compliance review
 * would ask for.
 */
const AnalysisLogSchema = new mongoose.Schema({
  ticker: { type: String, required: true, uppercase: true, index: true },
  timeframe: { type: String, default: '1D' },
  price: Number,
  finalAction: { type: String, index: true },
  direction: Number,
  compositeScore: Number,
  confidence: Number,
  probabilityOfProfit: Number,

  activeAgentIds: { type: [String], default: [] },
  activeAgentCount: Number,
  agentBreakdown: { type: Array, default: [] },
  consensus: { type: mongoose.Schema.Types.Mixed },
  metaLabel: { type: mongoose.Schema.Types.Mixed },
  positionSizing: { type: mongoose.Schema.Types.Mixed },
  executionPlan: { type: mongoose.Schema.Types.Mixed },
  vetoesTriggered: { type: Array, default: [] },
  blocked: { type: Boolean, default: false },
  executiveSummary: { type: [String], default: [] },

  dataProvider: String,
  elapsedMs: Number,

  // Filled in later by the performance attribution job, once the trade's
  // barriers have resolved.
  outcome: {
    resolved: { type: Boolean, default: false },
    barrierHit: { type: String, enum: ['PROFIT', 'STOP', 'TIME', null], default: null },
    returnPct: Number,
    resolvedAt: Date,
  },
}, { timestamps: true });

AnalysisLogSchema.index({ createdAt: -1 });

export default mongoose.models.AnalysisLog || mongoose.model('AnalysisLog', AnalysisLogSchema);
