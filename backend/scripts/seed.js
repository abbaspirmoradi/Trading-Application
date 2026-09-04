import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB, isDbConnected } from '../config/db.js';
import AgentModel from '../models/Agent.js';
import Portfolio from '../models/Portfolio.js';
import { listAgents } from '../agents/index.js';
import { getQuote } from '../data/marketDataService.js';

const DEMO_POSITIONS = [
  { ticker: 'AMD', side: 'LONG', shares: 400, entryPrice: 70.0, stopPrice: 64.5, thesis: 'Stage 2 breakout from a flat base on expanding volume.' },
  { ticker: 'NFLX', side: 'LONG', shares: 40, entryPrice: 520.0, stopPrice: 486.0, thesis: 'Cup-with-handle breakout, RS rating above 85.' },
];

async function main() {
  await connectDB();
  if (!isDbConnected()) {
    console.error('Seeding requires MongoDB. Start mongod, or just run the server — it falls back to an in-memory portfolio automatically.');
    process.exit(1);
  }

  for (const def of listAgents()) {
    await AgentModel.updateOne(
      { agentId: def.agentId },
      {
        $set: { name: def.name, cluster: def.cluster, description: def.description, baseWeight: def.baseWeight },
        $setOnInsert: { performance: { rollingSharpe30d: 0, brierScore: 0.25, callsMade: 0, callsCorrect: 0 } },
      },
      { upsert: true },
    );
  }
  console.log(`[seed] registered ${listAgents().length} agents`);

  const positions = [];
  for (const p of DEMO_POSITIONS) {
    const q = await getQuote(p.ticker).catch(() => null);
    positions.push({ ...p, currentPrice: q?.price ?? p.entryPrice, openedAt: new Date() });
  }

  const cash = 250000 - positions.reduce((a, p) => a + p.entryPrice * p.shares, 0);
  const equity = cash + positions.reduce((a, p) => a + p.currentPrice * p.shares, 0);

  await Portfolio.findOneAndUpdate(
    { owner: 'default-user' },
    {
      $set: {
        name: 'Primary Portfolio',
        equity, cash, startingEquity: 250000, peakEquity: Math.max(250000, equity),
        positions,
        watchlist: ['AAPL', 'NVDA', 'MSFT', 'AMZN', 'TSLA', 'META', 'GOOGL', 'AMD'],
      },
    },
    { upsert: true, new: true },
  );
  console.log(`[seed] portfolio: equity $${equity.toFixed(0)}, ${positions.length} positions`);

  await mongoose.disconnect();
  console.log('[seed] done');
}

main().catch((e) => { console.error(e); process.exit(1); });
