// End-to-end smoke test against a running server.
// Usage: npm start (in one shell), then npm run smoke
const BASE = process.env.SMOKE_BASE || 'http://localhost:4000';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    failed++;
  }
}

let AUTH = null;
const authHeaders = () => (AUTH ? { Authorization: `Bearer ${AUTH}` } : {});

const get = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: authHeaders() });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${j.error || 'request failed'}`);
  return j;
};
const post = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${j.error || 'request failed'}`);
  return j;
};
const patch = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${j.error || 'request failed'}`);
  return j;
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log(`\nSmoke testing ${BASE}\n`);

await check('registration issues a token', async () => {
  const email = `smoke-${Date.now()}@example.test`;
  const j = await post('/api/auth/register', { email, password: 'smoke-test-pw-123', name: 'Smoke', startingEquity: 250000 });
  assert(j.token, 'no token issued');
  assert(j.user.email === email, 'wrong user echoed back');
  AUTH = j.token;
});

await check('protected routes reject an anonymous caller', async () => {
  const r = await fetch(`${BASE}/api/portfolio`);
  assert(r.status === 401, `expected 401, got ${r.status}`);
});

await check('protected routes reject a tampered token', async () => {
  const r = await fetch(`${BASE}/api/portfolio`, { headers: { Authorization: `Bearer ${AUTH.slice(0, -3)}xyz` } });
  assert(r.status === 401, `expected 401, got ${r.status}`);
});

await check('duplicate registration is refused', async () => {
  const email = `dupe-${Date.now()}@example.test`;
  await post('/api/auth/register', { email, password: 'smoke-test-pw-123' });
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'smoke-test-pw-123' }),
  });
  assert(r.status === 409, `expected 409, got ${r.status}`);
});

await check('login rejects a wrong password without leaking whether the account exists', async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody-here@example.test', password: 'whatever123' }),
  });
  const j = await r.json();
  assert(r.status === 401, `expected 401, got ${r.status}`);
  assert(/invalid email or password/i.test(j.error), `error message leaks detail: ${j.error}`);
});

await check('health endpoint reports healthy', async () => {
  const j = await get('/api/health');
  assert(j.status === 'healthy', 'not healthy');
  assert(j.agents === 11, `expected 11 agents, got ${j.agents}`);
});

await check('agent registry returns all 11 agents', async () => {
  const j = await get('/api/agents');
  assert(j.agents.length === 11, `got ${j.agents.length}`);
  assert(j.agents.every((a) => a.agentId && a.cluster), 'malformed agent entry');
});

await check('pipeline description exposes 7 stages', async () => {
  const j = await get('/api/pipeline');
  assert(j.pipeline.stages.length === 7, `got ${j.pipeline.stages.length}`);
});

await check('full analysis returns a complete decision contract', async () => {
  const j = await post('/api/analyze', { ticker: 'NVDA' });
  const d = j.decision;
  assert(d.agentBreakdown.length === 11, `expected 11 agent results, got ${d.agentBreakdown.length}`);
  assert(typeof d.compositeScore === 'number', 'missing composite score');
  assert(d.executionPlan, 'missing execution plan');
  assert(d.executiveSummary.length > 0, 'empty executive summary');
  assert(d.positionSizing.portfolioPercent <= 5.001, 'position exceeds the 5% cap');
});

await check('analysis honours the active agent subset', async () => {
  const j = await post('/api/analyze', { ticker: 'AAPL', activeAgents: ['Weinstein_Stage_Agent', 'Chart_Pattern_Agent', 'Volume_OrderFlow_Agent'] });
  assert(j.decision.agentBreakdown.length === 3, `expected 3, got ${j.decision.agentBreakdown.length}`);
});

await check('quorum failure is reported rather than guessed', async () => {
  const j = await post('/api/analyze', { ticker: 'AAPL', activeAgents: ['CAN_SLIM_Agent'] });
  assert(j.decision.blocked === true, 'should be blocked');
  assert(/Quorum/.test(j.decision.blockReason), 'missing quorum reason');
});

await check('an unknown agent id is rejected with a 400', async () => {
  const r = await fetch(`${BASE}/api/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticker: 'AAPL', activeAgents: ['Not_A_Real_Agent'] }),
  });
  assert(r.status === 400, `expected 400, got ${r.status}`);
});

await check('an invalid ticker is rejected with a 400', async () => {
  const r = await fetch(`${BASE}/api/analyze?ticker=not!valid`);
  assert(r.status === 400, `expected 400, got ${r.status}`);
});

await check('batch analysis returns one row per ticker', async () => {
  const j = await post('/api/analyze/batch', { tickers: ['AAPL', 'NVDA', 'TSLA'] });
  assert(j.results.length === 3, `got ${j.results.length}`);
  assert(j.results.every((r) => r.finalAction), 'missing action');
});

await check('chart endpoint returns bars with overlays', async () => {
  const j = await get('/api/chart/NVDA?days=300');
  assert(j.bars.length > 100, 'too few bars');
  assert(j.bars.some((b) => b.ma150 != null), 'missing 150-day MA overlay');
  assert(j.weekly.some((w) => w.ma30w != null), 'missing 30-week MA overlay');
});

await check('market overview returns quotes and macro', async () => {
  const j = await get('/api/market/overview');
  assert(j.quotes.length > 0, 'no quotes');
  assert(typeof j.macro.vix === 'number', 'missing macro');
});

await check('portfolio endpoint returns heat and positions', async () => {
  const j = await get('/api/portfolio');
  assert(typeof j.portfolio.equity === 'number', 'missing equity');
  assert(Array.isArray(j.portfolio.positions), 'missing positions');
});

await check('a position breaching the risk ceiling is rejected', async () => {
  const r = await fetch(`${BASE}/api/portfolio/positions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ ticker: 'AAPL', shares: 100000, entryPrice: 100, stopPrice: 50 }),
  });
  assert(r.status === 422, `expected 422, got ${r.status}`);
});

await check('an inverted stop is rejected', async () => {
  const r = await fetch(`${BASE}/api/portfolio/positions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ ticker: 'AAPL', shares: 10, entryPrice: 100, stopPrice: 110 }),
  });
  assert(r.status === 400, `expected 400, got ${r.status}`);
});

await check('position lifecycle: create then delete', async () => {
  const created = await post('/api/portfolio/positions', { ticker: 'MSFT', shares: 5, entryPrice: 100, stopPrice: 95 });
  const pos = created.portfolio.positions.find((p) => p.ticker === 'MSFT');
  assert(pos, 'position not created');
  const r = await fetch(`${BASE}/api/portfolio/positions/${pos._id}`, { method: 'DELETE', headers: authHeaders() });
  assert(r.ok, 'delete failed');
});

await check('stress test returns a correlation matrix and scenarios', async () => {
  await post('/api/portfolio/positions', { ticker: 'AMD', shares: 20, entryPrice: 79, stopPrice: 74 });
  await post('/api/portfolio/positions', { ticker: 'NVDA', shares: 20, entryPrice: 36, stopPrice: 34 });
  const j = await get('/api/portfolio/stress-test');
  assert(j.stress.matrix.length >= 2, 'matrix too small');
  assert(j.stress.scenarios.length === 4, 'missing scenarios');
});

await check('backtest returns out-of-sample stats and a permutation p-value', async () => {
  const j = await post('/api/backtest', { ticker: 'NVDA', permutations: 50 });
  assert(j.backtest.outOfSample, 'missing OOS stats');
  assert(typeof j.backtest.permutationTest.pValue === 'number', 'missing p-value');
  assert(j.backtest.folds.length > 0, 'no walk-forward folds');
});

await check('analysis logs are persisted', async () => {
  const j = await get('/api/logs?limit=5');
  assert(j.logs.length > 0, 'no logs recorded');
});

await check('portfolio review returns holdings, alerts and correlations', async () => {
  await post('/api/portfolio/positions', { ticker: 'NVDA', shares: 10, entryPrice: 100, stopPrice: 90 });
  const j = await get('/api/portfolio/review');
  const r = j.review;
  assert(r.headline, 'no headline');
  assert(Array.isArray(r.alerts), 'no alerts array');
  assert(r.holdings.length >= 1, 'no holdings reviewed');
  assert(r.summary.verdicts, 'no verdict summary');
  assert(r.correlations, 'no correlation report');
});

await check('a breached stop is surfaced as a CRITICAL alert', async () => {
  // Entry and stop far above the market: the stop is already broken.
  await post('/api/portfolio/positions', { ticker: 'AMD', shares: 5, entryPrice: 99000, stopPrice: 98000 });
  const j = await get('/api/portfolio/review');
  const alert = j.review.alerts.find((a) => a.ticker === 'AMD' && a.code === 'STOP_BREACHED');
  assert(alert, 'breached stop was not reported');
  assert(alert.severity === 'CRITICAL', `expected CRITICAL, got ${alert.severity}`);
  assert(j.review.alerts[0].severity === 'CRITICAL', 'critical alerts must sort first');
});

await check('a position can be amended (stop raised)', async () => {
  const pf = (await get('/api/portfolio')).portfolio;
  const pos = pf.positions.find((p) => p.ticker === 'NVDA');
  const j = await patch(`/api/portfolio/positions/${pos._id}`, { stopPrice: 95 });
  const updated = j.portfolio.positions.find((p) => p.ticker === 'NVDA');
  assert(Number(updated.stopPrice) === 95, `stop was not updated: ${updated.stopPrice}`);
});

await check('daily picks return ranked, veto-free candidates', async () => {
  const j = await get('/api/picks?limit=5');
  const s = j.screen;
  assert(s.analysed > 0, 'nothing analysed');
  assert(Array.isArray(s.picks), 'no picks array');
  assert(s.marketBreadth.tone, 'no breadth tone');
  for (const p of s.picks) {
    assert(p.blocked === false, `${p.ticker} carries a blocking veto`);
    assert(p.stage !== 4, `${p.ticker} is in a Stage 4 decline`);
    assert(p.suggestedShares > 0, `${p.ticker} has no size`);
    assert(p.profitTarget > p.entryTrigger, `${p.ticker}: target is not beyond entry`);
  }
});

await check('picks are ranked in descending order of score', async () => {
  const s = (await get('/api/picks?limit=8')).screen;
  const scores = s.picks.map((p) => p.rankScore);
  assert(scores.every((v, i) => i === 0 || scores[i - 1] >= v), `not sorted: ${scores.join(', ')}`);
});

await check('WebSocket streams quotes', async () => {
  const { WebSocket } = await import('ws');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no quote frame within 12s')); }, 12000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', tickers: ['AAPL', 'NVDA'] })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'quotes' && msg.quotes.length) {
        clearTimeout(timer); ws.close(); resolve();
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
