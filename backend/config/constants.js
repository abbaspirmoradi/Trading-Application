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

/**
 * Barrier profiles by holding horizon.
 *
 * The horizon is not a cosmetic setting: it determines the labels the
 * meta-model learns from, the width of every stop, and how many independent
 * observations the history can yield. A stop sized for a two-week swing is
 * inside the noise of a two-year hold, and a 60-day time barrier would close a
 * position thesis before it has had a chance to be right or wrong.
 */
export const HORIZON_PROFILES = {
  // Weeks to months.
  SWING: {
    label: 'Swing (weeks to months)',
    profitAtrMultiple: 4.0,
    stopAtrMultiple: 2.0,
    minStopAtrMultiple: 0.8,
    atrPeriod: 14,
    maxHoldingDays: 60,
    minRewardRisk: 1.8,
    maxEntryDistancePct: 8,
    // History needed for indicators in the agent context.
    analysisDays: 750,
  },

  // Months to years. Wider stops so ordinary volatility cannot close a
  // multi-month thesis, a one-year vertical barrier, and five years of context
  // so the 30-week MA and 52-week range are measured against a real cycle.
  POSITION: {
    label: 'Position (months to years)',
    profitAtrMultiple: 10.0,
    stopAtrMultiple: 4.0,
    minStopAtrMultiple: 2.0,
    atrPeriod: 20,
    maxHoldingDays: 252,
    minRewardRisk: 2.0,
    // A position entry does not need to be timed to the tick, so a trigger may
    // sit further from spot before it stops being actionable.
    maxEntryDistancePct: 12,
    analysisDays: 1300,
  },
};

export const HORIZON = (process.env.TRADING_HORIZON || 'POSITION').toUpperCase();

export const BARRIERS = {
  ...(HORIZON_PROFILES[HORIZON] ?? HORIZON_PROFILES.POSITION),
  horizon: HORIZON_PROFILES[HORIZON] ? HORIZON : 'POSITION',
};

/**
 * Maximum daily history to request for backtesting and model fitting. At a
 * position horizon the label window is a year wide, so a short history yields
 * almost no independent observations — 20 years is the difference between a
 * testable sample and a meaningless one.
 */
export const HISTORY_MAX_DAYS = 5040;

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
