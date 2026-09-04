import mongoose from 'mongoose';
import { PositionSchema } from './Position.js';

const PortfolioSchema = new mongoose.Schema({
  name: { type: String, required: true, default: 'Primary Portfolio' },
  owner: { type: String, default: 'default-user', index: true },
  equity: { type: Number, required: true, default: 100000 },
  cash: { type: Number, required: true, default: 100000 },
  startingEquity: { type: Number, default: 100000 },
  peakEquity: { type: Number, default: 100000 },
  positions: { type: [PositionSchema], default: [] },
  watchlist: { type: [String], default: [] },
  riskSettings: {
    maxRiskPerTradePct: { type: Number, default: 1.0 },
    hardMaxPositionPct: { type: Number, default: 5.0 },
    maxPortfolioHeatPct: { type: Number, default: 6.0 },
    kellyFraction: { type: Number, default: 0.25 },
  },
}, { timestamps: true });

/** Aggregate open risk across every position, as a % of equity. */
PortfolioSchema.virtual('portfolioHeatPct').get(function heat() {
  const risk = this.positions.reduce((a, p) => {
    const px = p.currentPrice ?? p.entryPrice;
    const per = p.side === 'SHORT' ? p.stopPrice - px : px - p.stopPrice;
    return a + Math.max(0, per) * p.shares;
  }, 0);
  return this.equity ? (risk / this.equity) * 100 : 0;
});

PortfolioSchema.virtual('drawdownPct').get(function dd() {
  if (!this.peakEquity) return 0;
  return ((this.peakEquity - this.equity) / this.peakEquity) * 100;
});

PortfolioSchema.set('toJSON', { virtuals: true });
PortfolioSchema.set('toObject', { virtuals: true });

export default mongoose.models.Portfolio || mongoose.model('Portfolio', PortfolioSchema);
