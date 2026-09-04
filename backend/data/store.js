// Repository layer.
//
// Every read/write goes through here so the rest of the app never has to care
// whether Mongo is up. When it is, these are thin Mongoose calls; when it is
// not, an in-memory store with the same shape takes over. That keeps the app
// fully demonstrable with no database installed, without scattering
// `if (dbConnected)` branches through the controllers.

import Portfolio from '../models/Portfolio.js';
import AnalysisLog from '../models/AnalysisLog.js';
import AgentModel from '../models/Agent.js';
import User from '../models/User.js';
import { isDbConnected } from '../config/db.js';
import { listAgents } from '../agents/index.js';

const DEFAULT_PORTFOLIO = () => ({
  _id: 'memory-portfolio',
  name: 'Primary Portfolio',
  owner: 'default-user',
  equity: 250000,
  cash: 250000,
  startingEquity: 250000,
  peakEquity: 250000,
  positions: [],
  watchlist: ['AAPL', 'NVDA', 'MSFT', 'AMZN', 'TSLA', 'META', 'GOOGL', 'AMD'],
  riskSettings: { maxRiskPerTradePct: 1.0, hardMaxPositionPct: 5.0, maxPortfolioHeatPct: 6.0, kellyFraction: 0.25 },
});

// Portfolios are keyed by owner so the in-memory mode supports multiple users
// with exactly the same semantics as the Mongo-backed path.
const memory = {
  portfolios: new Map(),
  users: new Map(), // email -> user record
  logs: [],
  agents: listAgents().map((a) => ({
    ...a,
    performance: { rollingSharpe30d: 0, brierScore: 0.25, callsMade: 0, callsCorrect: 0 },
  })),
};

let nextId = 1;

function memPortfolio(owner) {
  if (!memory.portfolios.has(owner)) {
    memory.portfolios.set(owner, { ...DEFAULT_PORTFOLIO(), _id: `mem-pf-${owner}`, owner });
  }
  return memory.portfolios.get(owner);
}

/* ------------------------------- users ------------------------------- */

export async function createUser({ email, name, passwordHash }) {
  const normalised = email.toLowerCase().trim();
  if (!isDbConnected()) {
    if (memory.users.has(normalised)) throw Object.assign(new Error('An account with that email already exists'), { status: 409 });
    const user = { _id: `mem-user-${nextId++}`, id: `mem-user-${nextId}`, email: normalised, name, passwordHash, createdAt: new Date().toISOString() };
    user.id = user._id;
    memory.users.set(normalised, user);
    return user;
  }
  const existing = await User.findOne({ email: normalised });
  if (existing) throw Object.assign(new Error('An account with that email already exists'), { status: 409 });
  const doc = await User.create({ email: normalised, name, passwordHash });
  return { ...doc.toObject(), id: String(doc._id) };
}

export async function findUserByEmail(email) {
  const normalised = String(email || '').toLowerCase().trim();
  if (!isDbConnected()) return memory.users.get(normalised) || null;
  const doc = await User.findOne({ email: normalised });
  return doc ? { ...doc.toObject(), id: String(doc._id) } : null;
}

export async function findUserById(id) {
  if (!isDbConnected()) {
    return [...memory.users.values()].find((u) => String(u._id) === String(id)) || null;
  }
  try {
    const doc = await User.findById(id);
    return doc ? { ...doc.toObject(), id: String(doc._id) } : null;
  } catch {
    return null;
  }
}

export async function touchLogin(id) {
  if (!isDbConnected()) return;
  await User.updateOne({ _id: id }, { $set: { lastLoginAt: new Date() } }).catch(() => {});
}

/* ----------------------------- portfolio ----------------------------- */

export async function getPortfolio(owner = 'default-user') {
  if (!isDbConnected()) return withHeat(memPortfolio(owner));
  let pf = await Portfolio.findOne({ owner });
  if (!pf) pf = await Portfolio.create({ ...DEFAULT_PORTFOLIO(), _id: undefined, owner });
  return pf.toJSON();
}

export async function savePortfolio(update, owner = 'default-user') {
  if (!isDbConnected()) {
    const pf = { ...memPortfolio(owner), ...update };
    memory.portfolios.set(owner, pf);
    return withHeat(pf);
  }
  const pf = await Portfolio.findOneAndUpdate({ owner }, { $set: update }, { new: true, upsert: true });
  return pf.toJSON();
}

export async function addPosition(position, owner = 'default-user') {
  if (!isDbConnected()) {
    const pf = memPortfolio(owner);
    pf.positions.push({ ...position, _id: `mem-${nextId++}`, openedAt: new Date().toISOString() });
    pf.cash -= (position.currentPrice ?? position.entryPrice) * position.shares;
    return withHeat(pf);
  }
  const pf = await Portfolio.findOneAndUpdate(
    { owner },
    { $push: { positions: position }, $inc: { cash: -((position.currentPrice ?? position.entryPrice) * position.shares) } },
    { new: true, upsert: true },
  );
  return pf.toJSON();
}

export async function removePosition(positionId, owner = 'default-user') {
  if (!isDbConnected()) {
    const pf = memPortfolio(owner);
    const p = pf.positions.find((x) => String(x._id) === String(positionId));
    if (p) pf.cash += (p.currentPrice ?? p.entryPrice) * p.shares;
    pf.positions = pf.positions.filter((x) => String(x._id) !== String(positionId));
    return withHeat(pf);
  }
  const pf = await Portfolio.findOne({ owner });
  if (!pf) return null;
  const p = pf.positions.id(positionId);
  if (p) {
    pf.cash += (p.currentPrice ?? p.entryPrice) * p.shares;
    p.deleteOne();
    await pf.save();
  }
  return pf.toJSON();
}

export async function updatePosition(positionId, patch, owner = 'default-user') {
  if (!isDbConnected()) {
    const pf = memPortfolio(owner);
    const p = pf.positions.find((x) => String(x._id) === String(positionId));
    if (!p) return null;
    Object.assign(p, patch);
    return withHeat(pf);
  }
  const pf = await Portfolio.findOne({ owner });
  if (!pf) return null;
  const p = pf.positions.id(positionId);
  if (!p) return null;
  Object.assign(p, patch);
  await pf.save();
  return pf.toJSON();
}

/** Marks every position to market and refreshes equity / peak equity. */
export async function markToMarket(quotes, owner = 'default-user') {
  const pf = await getPortfolio(owner);
  const priceBy = Object.fromEntries(quotes.map((q) => [q.ticker, q.price]));
  const positions = (pf.positions || []).map((p) => ({
    ...(p.toObject ? p.toObject() : p),
    currentPrice: priceBy[p.ticker] ?? p.currentPrice ?? p.entryPrice,
  }));
  const marketValue = positions.reduce((a, p) => a + p.currentPrice * p.shares, 0);
  const equity = (pf.cash ?? 0) + marketValue;
  const peakEquity = Math.max(pf.peakEquity ?? equity, equity);

  if (!isDbConnected()) {
    const pf = { ...memPortfolio(owner), positions, equity, peakEquity };
    memory.portfolios.set(owner, pf);
    return withHeat(pf);
  }
  const updated = await Portfolio.findOneAndUpdate(
    { owner }, { $set: { positions, equity, peakEquity } }, { new: true },
  );
  return updated ? updated.toJSON() : pf;
}

function withHeat(pf) {
  const openRisk = pf.positions.reduce((a, p) => {
    const px = p.currentPrice ?? p.entryPrice;
    const per = p.side === 'SHORT' ? p.stopPrice - px : px - p.stopPrice;
    return a + Math.max(0, per) * p.shares;
  }, 0);
  const marketValue = pf.positions.reduce((a, p) => a + (p.currentPrice ?? p.entryPrice) * p.shares, 0);
  return {
    ...pf,
    positions: pf.positions.map((p) => ({
      ...p,
      marketValue: (p.currentPrice ?? p.entryPrice) * p.shares,
      openRisk: Math.max(0, (p.side === 'SHORT' ? p.stopPrice - (p.currentPrice ?? p.entryPrice) : (p.currentPrice ?? p.entryPrice) - p.stopPrice)) * p.shares,
      unrealizedPnl: ((p.side === 'SHORT' ? p.entryPrice - (p.currentPrice ?? p.entryPrice) : (p.currentPrice ?? p.entryPrice) - p.entryPrice)) * p.shares,
    })),
    marketValue,
    openRisk,
    portfolioHeatPct: pf.equity ? (openRisk / pf.equity) * 100 : 0,
    drawdownPct: pf.peakEquity ? ((pf.peakEquity - pf.equity) / pf.peakEquity) * 100 : 0,
  };
}

/* ------------------------------- logs -------------------------------- */

export async function saveAnalysisLog(decision, owner = 'default-user') {
  const doc = {
    ticker: decision.ticker,
    timeframe: decision.timeframe,
    price: decision.price,
    finalAction: decision.finalAction,
    direction: decision.direction,
    compositeScore: decision.compositeScore,
    confidence: decision.confidence,
    probabilityOfProfit: decision.probabilityOfProfit,
    activeAgentIds: (decision.agentBreakdown || []).map((a) => a.agentId),
    activeAgentCount: decision.activeAgentCount,
    agentBreakdown: decision.agentBreakdown,
    consensus: decision.consensus,
    metaLabel: decision.metaLabel,
    positionSizing: decision.positionSizing,
    executionPlan: decision.executionPlan,
    vetoesTriggered: decision.vetoesTriggered,
    blocked: decision.blocked,
    executiveSummary: decision.executiveSummary,
    dataProvider: decision.dataProvider,
    elapsedMs: decision.elapsedMs,
  };

  if (!isDbConnected()) {
    const entry = { ...doc, owner, _id: `log-${nextId++}`, createdAt: new Date().toISOString() };
    memory.logs.unshift(entry);
    memory.logs = memory.logs.slice(0, 200);
    return entry;
  }
  return (await AnalysisLog.create(doc)).toJSON();
}

export async function listAnalysisLogs({ ticker, limit = 25 } = {}) {
  if (!isDbConnected()) {
    return memory.logs.filter((l) => !ticker || l.ticker === ticker.toUpperCase()).slice(0, limit);
  }
  const q = ticker ? { ticker: ticker.toUpperCase() } : {};
  return (await AnalysisLog.find(q).sort({ createdAt: -1 }).limit(limit)).map((d) => d.toJSON());
}

/* ------------------------------ agents ------------------------------- */

export async function listAgentRegistry() {
  if (!isDbConnected()) return memory.agents;

  const defs = listAgents();
  // Keep the persisted registry in step with the code-level registry.
  await Promise.all(defs.map((d) => AgentModel.updateOne(
    { agentId: d.agentId },
    { $setOnInsert: { ...d, performance: { rollingSharpe30d: 0, brierScore: 0.25, callsMade: 0, callsCorrect: 0 } } },
    { upsert: true },
  )));
  return (await AgentModel.find({})).map((a) => a.toJSON());
}

/** Map of agentId -> dynamic consensus weight, derived from rolling performance. */
export async function getPerformanceWeights() {
  if (!isDbConnected()) return {};
  const docs = await AgentModel.find({});
  return Object.fromEntries(docs.map((d) => [d.agentId, d.dynamicWeight()]));
}
