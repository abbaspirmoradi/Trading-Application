// Central policy + registry constants. Everything tunable lives here so the
// quant rules are auditable in one place.

export const RISK = {
  maxRiskPerTradePct: Number(process.env.MAX_RISK_PER_TRADE_PCT ?? 1.0), // % equity risked per idea
  hardMaxPositionPct: Number(process.env.HARD_MAX_POSITION_PCT ?? 5.0),  // never > 5% of equity in one idea
  maxPortfolioHeatPct: Number(process.env.MAX_PORTFOLIO_HEAT_PCT ?? 6.0),
  correlationVetoThreshold: 0.70,
  correlationWarnThreshold: 0.55,
  kellyFraction: Number(process.env.KELLY_FRACTION ?? 0.25),             // quarter-Kelly
  deleverageDrawdownPct: 5.0,
};

export const BREAKOUT = {
  volumeConfirmMultiple: 1.5,   // below this => Volume Veto (downgrade / halve size)
  volumeIdealMultiple: 2.0,     // "institutional" confirmation
  volumeLookback: 20,
};

export const BARRIERS = {
  profitAtrMultiple: 4.0,
  stopAtrMultiple: 2.0,
  // A stop closer than this to entry sits inside normal daily noise: it will be
  // hit by random fluctuation rather than by the thesis failing.
  minStopAtrMultiple: 0.8,
  atrPeriod: 14,
  maxHoldingDays: 60,           // vertical (time) barrier
  minRewardRisk: 1.8,
  // A breakout trigger further than this above spot is not a trade you can place
  // today — it is a level to watch. Buying a stop 30% above the market is how a
  // detected pattern turns into a fictional entry.
  maxEntryDistancePct: 8,
};

export const QUORUM = {
  minActiveAgents: 3,
  // A decision is only "high conviction" if at least one agent from each of
  // these clusters voted.
  requiredClustersForHighConviction: ['TECHNICAL', 'RISK'],
};

export const CLUSTERS = {
  FUNDAMENTAL: 'FUNDAMENTAL',
  TECHNICAL: 'TECHNICAL',
  QUANT: 'QUANT',
  MACRO: 'MACRO',
  SENTIMENT: 'SENTIMENT',
  RISK: 'RISK',
  EXECUTION: 'EXECUTION',
};

export const SIGNALS = { BULLISH: 'BULLISH', BEARISH: 'BEARISH', NEUTRAL: 'NEUTRAL' };

export const ACTIONS = {
  STRONG_BUY: 'STRONG_BUY',
  BUY: 'BUY',
  HOLD: 'HOLD',
  REDUCE: 'REDUCE',
  SELL: 'SELL',
  SHORT: 'SHORT',
};

export const NASDAQ_QUICK_PICKS = [
  'AAPL', 'NVDA', 'MSFT', 'AMZN', 'TSLA', 'META', 'GOOGL', 'AVGO', 'AMD', 'NFLX',
];

/**
 * Screening universe: liquid NASDAQ large- and mid-caps across the sectors the
 * agent set is designed for. Kept to ~50 names deliberately — every symbol is
 * one provider request, and a screen that hammers the data source is a screen
 * that stops working.
 */
export const SCREENER_UNIVERSE = [
  // Mega-cap technology
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'NFLX', 'COST',
  // Semiconductors
  'AMD', 'QCOM', 'INTC', 'MU', 'AMAT', 'LRCX', 'KLAC', 'ADI', 'NXPI', 'MRVL', 'ON', 'ASML',
  // Software & internet
  'ADBE', 'CRWD', 'PANW', 'SNPS', 'CDNS', 'INTU', 'WDAY', 'DDOG', 'TEAM', 'ZS', 'MDB', 'ORCL',
  // Consumer & communications
  'SBUX', 'PEP', 'MDLZ', 'BKNG', 'ABNB', 'MAR', 'LULU', 'DASH',
  // Biotech & healthcare
  'AMGN', 'GILD', 'REGN', 'VRTX', 'ISRG', 'MRNA',
  // Other index heavyweights
  'CSCO', 'TXN', 'HON', 'PYPL',
];

export const BENCHMARK = 'QQQ';
