import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search, Play, Loader2, Shield, LayoutGrid, AlertTriangle, Server, Database, Radio,
  Briefcase, Sparkles, LineChart, LogOut,
} from 'lucide-react';

import AgentSelector from './components/AgentSelector.jsx';
import AnalysisDashboard from './components/AnalysisDashboard.jsx';
import PortfolioRiskView from './components/PortfolioRiskView.jsx';
import MarketOverview from './components/MarketOverview.jsx';
import BacktestPanel from './components/BacktestPanel.jsx';
import PortfolioAdvisor from './components/PortfolioAdvisor.jsx';
import DailyPicks from './components/DailyPicks.jsx';
import LoginView from './components/LoginView.jsx';

import { useAuth } from './context/AuthContext.jsx';
import { useAgents } from './context/AgentContext.jsx';
import { usePortfolio } from './context/PortfolioContext.jsx';
import api from './services/api.js';
import marketSocket from './services/socket.js';

const QUICK_PICKS = ['AAPL', 'NVDA', 'MSFT', 'AMZN', 'TSLA', 'META', 'GOOGL', 'AMD', 'AVGO', 'NFLX'];
const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

const TABS = [
  { id: 'analysis', label: 'Analysis', Icon: LineChart },
  { id: 'portfolio', label: 'My Portfolio', Icon: Briefcase },
  { id: 'picks', label: 'Daily Picks', Icon: Sparkles },
];

export default function App() {
  const { user, checking, isAuthenticated, signOut } = useAuth();
  const { activeIds, activeCount } = useAgents();
  const { portfolio, refresh: refreshPortfolio } = usePortfolio();

  const [tab, setTab] = useState('analysis');
  const [ticker, setTicker] = useState('NVDA');
  const [input, setInput] = useState('NVDA');
  const [decision, setDecision] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const [quotes, setQuotes] = useState([]);
  const [macro, setMacro] = useState(null);
  const [dataProvider, setDataProvider] = useState(null);
  const [macroSource, setMacroSource] = useState(null);
  const [macroNote, setMacroNote] = useState(null);
  const [socketStatus, setSocketStatus] = useState('disconnected');
  const [health, setHealth] = useState(null);
  const [riskOpen, setRiskOpen] = useState(false);

  /* -------------------------- bootstrap -------------------------- */
  useEffect(() => {
    if (!isAuthenticated) return;
    api.health().then(setHealth).catch(() => setHealth(null));
    api.marketOverview(QUICK_PICKS)
      .then((res) => {
        setQuotes(res.quotes);
        setMacro(res.macro);
        setDataProvider(res.provider);
        setMacroSource(res.macroSource);
        setMacroNote(res.macroNote);
      })
      .catch(() => {});
  }, [isAuthenticated]);

  /* ------------------------ live quotes -------------------------- */
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    marketSocket.connect();
    const off = marketSocket.on((msg) => {
      if (msg.type === 'status') setSocketStatus(msg.status);
      if (msg.type === 'quotes') {
        setQuotes((prev) => {
          const next = new Map(prev.map((q) => [q.ticker, q]));
          msg.quotes.forEach((q) => next.set(q.ticker, q));
          return [...next.values()];
        });
      }
    });
    marketSocket.subscribe([...new Set([...QUICK_PICKS, ticker])]);
    return () => { off(); };
  }, [ticker, isAuthenticated]);

  /* -------------------------- analysis --------------------------- */
  const runAnalysis = useCallback(async (symbol = ticker) => {
    const t = String(symbol || '').toUpperCase().trim();
    if (!t) return;
    setTab('analysis');
    setRunning(true);
    setError(null);
    try {
      const { decision: d } = await api.analyze(t, activeIds);
      setDecision(d);
      setTicker(t);
      setInput(t);
    } catch (err) {
      setError(err.message);
      setDecision(null);
    } finally {
      setRunning(false);
    }
  }, [ticker, activeIds]);

  const runStatus = useMemo(() => Object.fromEntries(
    (decision?.agentBreakdown || []).map((a) => [a.agentId, a.status]),
  ), [decision]);

  const suggestion = useMemo(() => {
    if (!decision || decision.blocked) return null;
    const shares = decision.positionSizing?.suggestedShares ?? 0;
    const plan = decision.executionPlan;
    if (shares <= 0 || !plan?.stopLoss || ['NONE', 'WATCH'].includes(plan.orderType)) return null;
    return {
      ticker: decision.ticker,
      side: decision.direction > 0 ? 'LONG' : 'SHORT',
      shares,
      entryPrice: plan.triggerPrice ?? decision.price,
      stopPrice: plan.stopLoss,
      profitTarget: plan.profitTarget,
      thesis: decision.executiveSummary?.[0] ?? '',
    };
  }, [decision]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!isAuthenticated) return <LoginView />;

  const heat = portfolio?.portfolioHeatPct ?? 0;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 bg-slate-950/85 backdrop-blur border-b border-slate-800">
        <div className="max-w-[1800px] mx-auto px-4 py-3 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-emerald-500/15">
              <LayoutGrid className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-slate-100 leading-tight">Multi-Agent Trading Terminal</h1>
              <p className="text-[10px] text-slate-500 leading-tight">
                {user?.name ? `${user.name} · ` : ''}{user?.email}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-1 min-w-[280px] max-w-lg">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && runAnalysis(input)}
                placeholder="Enter a NASDAQ ticker…"
                className="w-full pl-8 pr-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-700 focus:ring-1 focus:ring-sky-800"
              />
            </div>
            <button
              type="button"
              onClick={() => runAnalysis(input)}
              disabled={running || activeCount < 3}
              className="btn-primary flex items-center gap-1.5 px-4 py-2 whitespace-nowrap"
              title={activeCount < 3 ? 'At least 3 agents must be active to reach quorum' : 'Run the agent pipeline'}
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {running ? 'Analysing…' : 'Analyse'}
            </button>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => setRiskOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:bg-slate-800 transition-colors"
            >
              <Shield className="w-3.5 h-3.5 text-rose-400" />
              <div className="text-left leading-tight">
                <div className="text-[9.5px] text-slate-500 uppercase tracking-wider">Equity</div>
                <div className="text-xs font-semibold text-slate-100 tabular-nums">{usd(portfolio?.equity)}</div>
              </div>
              <div className="text-left leading-tight pl-2 border-l border-slate-800">
                <div className="text-[9.5px] text-slate-500 uppercase tracking-wider">Heat</div>
                <div className={`text-xs font-semibold tabular-nums ${heat > 6 ? 'text-rose-400' : heat > 4 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {heat.toFixed(2)}%
                </div>
              </div>
            </button>
            <button
              type="button" onClick={signOut} title="Sign out"
              className="p-2 rounded-lg bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-500 hover:text-slate-300"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Primary navigation */}
        <div className="max-w-[1800px] mx-auto px-4 flex gap-1">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                tab === id
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-[1800px] mx-auto px-4 py-4 space-y-4">
        {health && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[10.5px] text-slate-500">
            <span className="flex items-center gap-1.5"><Server className="w-3 h-3" /> {health.agents} agents registered</span>
            <span className="flex items-center gap-1.5"><Database className="w-3 h-3" /> {health.database}</span>
            <span className="flex items-center gap-1.5"><Radio className="w-3 h-3" /> bus: {health.eventBus} · data: {health.marketDataProvider}</span>
          </div>
        )}

        <MarketOverview
          quotes={quotes}
          macro={macro}
          selected={ticker}
          onSelect={(t) => runAnalysis(t)}
          socketStatus={socketStatus}
          provider={dataProvider}
          macroSource={macroSource}
          macroNote={macroNote}
        />

        <AgentSelector runStatus={runStatus} running={running} />

        {tab === 'analysis' && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_PICKS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => runAnalysis(t)}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                    ticker === t ? 'bg-sky-500/15 text-sky-300' : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {error && (
              <div className="panel p-4 flex items-start gap-2.5 border-rose-900/60">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-rose-300 font-medium">Analysis failed</p>
                  <p className="text-xs text-slate-400 mt-0.5">{error}</p>
                </div>
              </div>
            )}

            {activeCount < 3 && !decision && (
              <div className="panel p-6 text-center">
                <p className="text-sm text-slate-300 font-medium">Quorum not met</p>
                <p className="text-xs text-slate-500 mt-1">
                  Activate at least three agents — the orchestrator will not issue a decision on a thinner panel than that.
                </p>
              </div>
            )}

            {running && !decision && (
              <div className="panel p-12 flex flex-col items-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
                <p className="text-sm text-slate-400">Running {activeCount} agents against {input}…</p>
              </div>
            )}

            {decision && <AnalysisDashboard decision={decision} ticker={ticker} />}
            {decision && <BacktestPanel ticker={ticker} />}

            {!decision && !running && activeCount >= 3 && (
              <div className="panel p-12 text-center">
                <LayoutGrid className="w-8 h-8 text-slate-700 mx-auto mb-3" />
                <p className="text-sm text-slate-300 font-medium">Ready to analyse</p>
                <p className="text-xs text-slate-500 mt-1">
                  {activeCount} agents are active. Pick a ticker and run the pipeline.
                </p>
              </div>
            )}
          </>
        )}

        {tab === 'portfolio' && <PortfolioAdvisor />}

        {tab === 'picks' && <DailyPicks onAnalyse={runAnalysis} />}
      </main>

      <PortfolioRiskView
        open={riskOpen}
        onClose={() => { setRiskOpen(false); refreshPortfolio(); }}
        suggestion={suggestion}
      />
    </div>
  );
}
