import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { connectDB, isDbConnected } from './config/db.js';
import { initEventBus, subscribe, publish, busDriver, TOPICS } from './bus/eventBus.js';
import analysisRoutes from './routes/analysisRoutes.js';
import portfolioRoutes from './routes/portfolioRoutes.js';
import authRoutes from './routes/authRoutes.js';
import { requireAuth, optionalAuth } from './middleware/requireAuth.js';
import { getQuote, provider } from './data/marketDataService.js';
import { NASDAQ_QUICK_PICKS } from './config/constants.js';
import { AGENT_IDS } from './agents/index.js';
import { describePipeline } from './workflow/decisionPipeline.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use((req, _res, next) => {
  if (req.path !== '/api/health') console.log(`[api] ${req.method} ${req.path}`);
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    database: isDbConnected() ? 'connected' : 'ephemeral (in-memory fallback)',
    eventBus: busDriver(),
    marketDataProvider: provider(),
    agents: AGENT_IDS.length,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/api/pipeline', (_req, res) => res.json({ ok: true, pipeline: describePipeline() }));

app.use('/api/auth', authRoutes);
// Analysis stays explorable while logged out (sizing then falls back to a
// neutral default portfolio); anything that touches your holdings does not.
app.use('/api', optionalAuth, analysisRoutes);
app.use('/api/portfolio', requireAuth, portfolioRoutes);

/* ----------------------- static frontend ----------------------- */
// In production the built SPA is served by this same process, so the browser
// talks to one origin: no CORS, and the WebSocket shares the page's host and
// TLS. In development Vite serves the app and proxies here instead, so this
// block is simply inert (no dist directory exists).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../frontend/dist');

if (fs.existsSync(path.join(distPath, 'index.html'))) {
  // Hashed asset filenames are safe to cache hard; index.html must not be.
  app.use(express.static(distPath, {
    maxAge: '1y',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  // SPA fallback: any non-API path renders the app shell so client-side routes
  // survive a hard refresh. Registered after the API so it cannot shadow it.
  app.get(/^(?!\/api\/|\/ws).*/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
  console.log(`[server] serving the built frontend from ${distPath}`);
} else {
  console.log('[server] no frontend build found — API only (run the Vite dev server for the UI)');
}

app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// Central error handler — validation errors carry a status, everything else is a 500.
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[api] error:', err);
  res.status(status).json({ ok: false, error: err.message || 'Internal server error' });
});

const server = http.createServer(app);

/* --------------------------- WebSocket layer --------------------------- */
// Clients subscribe to a ticker set; the server pushes quote ticks and mirrors
// every orchestration event published on the bus.

const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Map(); // ws -> Set<ticker>

wss.on('connection', (ws) => {
  clients.set(ws, new Set(NASDAQ_QUICK_PICKS.slice(0, 5)));
  ws.send(JSON.stringify({ type: 'connected', provider: provider(), eventBus: busDriver(), ts: new Date().toISOString() }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'subscribe' && Array.isArray(msg.tickers)) {
        clients.set(ws, new Set(msg.tickers.map((t) => String(t).toUpperCase()).slice(0, 30)));
        ws.send(JSON.stringify({ type: 'subscribed', tickers: [...clients.get(ws)] }));
      }
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    } catch { /* ignore malformed frames */ }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const [ws] of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// Mirror orchestration events out to every connected dashboard.
for (const topic of [TOPICS.ANALYSIS_REQUESTED, TOPICS.AGENTS_COMPLETED, TOPICS.DECISION, TOPICS.PORTFOLIO_UPDATED]) {
  subscribe(topic, (envelope) => broadcast({ type: 'event', topic, ...envelope }));
}

/**
 * Quote polling loop. Every tick is published to the bus (so a Kafka deployment
 * fans it out across services) and the bus subscription pushes it to clients.
 */
const QUOTE_INTERVAL_MS = 5000;
let quoteTimer = null;

async function pollQuotes() {
  const wanted = new Set();
  for (const [, tickers] of clients) for (const t of tickers) wanted.add(t);
  if (!wanted.size) return;

  const quotes = await Promise.all([...wanted].slice(0, 30).map((t) => getQuote(t).catch(() => null)));
  const live = quotes.filter(Boolean);
  if (live.length) {
    await publish(TOPICS.PRICE_TICK, { quotes: live });
    // Deliver only the tickers each client actually asked for.
    for (const [ws, tickers] of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const mine = live.filter((q) => tickers.has(q.ticker));
      if (mine.length) ws.send(JSON.stringify({ type: 'quotes', quotes: mine, ts: Date.now() }));
    }
  }
}

const PORT = process.env.PORT || 4000;

async function start() {
  await connectDB();
  await initEventBus();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Multi-Agent Trading Engine`);
    console.log(`  REST      http://localhost:${PORT}/api`);
    console.log(`  WebSocket ws://localhost:${PORT}/ws`);
    console.log(`  Agents    ${AGENT_IDS.length} registered | data: ${provider()} | bus: ${busDriver()}\n`);
  });
  quoteTimer = setInterval(() => pollQuotes().catch(() => {}), QUOTE_INTERVAL_MS);
}

async function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down`);
  clearInterval(quoteTimer);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});

export { app, server };
