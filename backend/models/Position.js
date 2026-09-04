import mongoose from 'mongoose';

/**
 * Positions are embedded in the portfolio document rather than living in their
 * own collection: a position has no meaning outside its portfolio, and
 * embedding keeps "add position + recompute heat" a single atomic write.
 */
export const PositionSchema = new mongoose.Schema({
  ticker: { type: String, required: true, uppercase: true, trim: true },
  side: { type: String, enum: ['LONG', 'SHORT'], default: 'LONG' },
  shares: { type: Number, required: true, min: 0 },
  entryPrice: { type: Number, required: true, min: 0 },
  currentPrice: { type: Number, min: 0 },
  stopPrice: { type: Number, required: true, min: 0 },
  profitTarget: { type: Number, min: 0 },
  timeBarrier: { type: Date },
  openedAt: { type: Date, default: Date.now },
  thesis: { type: String, default: '' },
  originatingDecisionId: { type: String, default: null },
}, { _id: true });

// Open risk in dollars: distance to stop x shares, floored at zero for
// positions whose stop has already been trailed past entry.
PositionSchema.virtual('openRisk').get(function openRisk() {
  const px = this.currentPrice ?? this.entryPrice;
  const perShare = this.side === 'SHORT' ? this.stopPrice - px : px - this.stopPrice;
  return Math.max(0, perShare) * this.shares;
});

PositionSchema.virtual('marketValue').get(function marketValue() {
  return (this.currentPrice ?? this.entryPrice) * this.shares;
});

PositionSchema.virtual('unrealizedPnl').get(function unrealizedPnl() {
  const px = this.currentPrice ?? this.entryPrice;
  const per = this.side === 'SHORT' ? this.entryPrice - px : px - this.entryPrice;
  return per * this.shares;
});

PositionSchema.set('toJSON', { virtuals: true });
PositionSchema.set('toObject', { virtuals: true });

export default mongoose.models.Position || mongoose.model('Position', PositionSchema);
