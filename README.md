# Multi-Agent Trading Terminal

A full-stack MERN application that analyses NASDAQ equities through eleven independent
analytical agents, reviews your actual holdings, and screens the market daily for
candidates — producing risk-bounded execution contracts rather than opinions.

The system is opinionated about one thing above all: **risk rules cannot be outvoted.**
No amount of bullish consensus buys a Stage 4 downtrend, and no conviction level exceeds
the 5% single-idea ceiling.

---

## Contents

- [Quick start](#quick-start)
- [UI guide — every screen explained](#ui-guide--every-screen-explained)
- [Data provenance](#data-provenance)
- [The eleven agents](#the-eleven-agents)
- [Decision pipeline](#decision-pipeline)
- [Portfolio Advisor](#portfolio-advisor)
- [Daily Picks](#daily-picks)
- [Backtesting & audit](#backtesting--audit)
- [Accounts & security](#accounts--security)
- [Deployment](#deployment)
- [API reference](#api-reference)
- [Configuration](#configuration)
- [Testing](#testing)
- [Scope notes](#scope-notes)

---

## Quick start

```bash
npm run install:all          # backend + frontend

npm run dev:backend          # terminal 1 -> http://localhost:4000
npm run dev:frontend         # terminal 2 -> http://localhost:5173
```

Open **http://localhost:5173**, create an account, enter your account equity, and add your
holdings. No database, message broker or API key is required.

The active configuration uses **real daily price data** from Yahoo Finance, which needs
network access. Set `MARKET_DATA_PROVIDER=synthetic` in `backend/.env` to run fully
offline. Either way, read [Data provenance](#data-provenance) before treating any number
on screen as fact.

```bash
npm test        # 32 unit tests — engine maths, veto rules, barriers, advisor, screener, macro
npm run smoke   # 29 end-to-end API tests (backend must be running)
```

---

## UI guide — every screen explained

### Sign in / Create account

The gate. Registration asks for **account equity**, and it is not cosmetic: every risk
limit, position size and heat calculation in the system is a percentage of that number.
Without it the advisor has no denominator.

Sessions are JWTs held in `localStorage` and last 30 days. Each account has its own
portfolio, holdings and analysis history — fully isolated from any other account.

### Header (always visible)

| Element | What it does |
|---|---|
| **Ticker box + Analyse** | Runs the full agent pipeline on any symbol. Disabled below three active agents, because the orchestrator refuses to decide without quorum. |
| **Equity / Heat pill** | Live account equity and portfolio heat. Heat turns amber past 4% and red past the 6% ceiling. Click it to open the Risk & Stress modal. |
| **Sign out** | Ends the session. |
| **Tabs** | Analysis · My Portfolio · Daily Picks. |

### Market Overview (all tabs)

A horizontal strip of watchlist quotes; click any to analyse it. Below sits the macro bar
— 10Y yield, DXY, VIX, VXN, 2s10s curve, high-yield spread, net new highs, oil, gold —
which is exactly what the Intermarket agent reads.

Two badges matter here:

- **`PRICES LIVE`** (green) or **`SIMULATED DATA`** (amber) — whether prices are real.
- **`modelled`** on the macro row — those macro values are generated, not observed.
- **`live` / `disconnected`** — WebSocket health. Note this reports *connection* health,
  not price movement: the feed is daily closes, so the number itself won't tick intraday.

### Agent Control Panel (all tabs)

The eleven agents as individually toggleable cards.

- **Select All / Reset / Clear All** — bulk controls.
- **Cluster chips** (Fundamental, Technical, Quant, Macro, Sentiment, Risk, Execution) —
  toggle a whole cluster; each shows `on/total`.
- **`X of 11 Agents Active`** — green at quorum, amber below three, red at zero.
- **Per-card status** — `READY`, `COMPUTING`, `COMPLETE`, `ERROR`, `INACTIVE`.
- **`MODELLED` / `PARTLY MODELLED` badges** — that agent's inputs are generated rather
  than observed. Expanding the card explains which feed and why it matters.

Your selection persists across reloads: an agent configuration is a deliberate choice.

---

### Tab 1 — Analysis

Deep-dive on a single symbol.

**Executive Decision Card.** The verdict, colour-coded by action (emerald buy, amber hold,
rose sell/short):

- **Composite / Confidence / P(profit)** — weighted consensus on [-100, +100], confidence
  adjusted for how much agents actually agree, and the meta-model's calibrated probability
  that the profit target is reached before the stop.
- **Two gauges** — composite conviction (centre-origin, so direction is visible at a
  glance) and directional agreement.
- **Veto banners** — every triggered rule, red for BLOCK and amber for downgrade, each
  showing its size multiplier and the reason.
- **Position Sizing** — suggested shares, allocation, % of equity, dollars at risk, full
  Kelly f\*, the fractional multiplier, and **which constraint actually bound** the size.
- **Execution Plan & Triple Barrier** — order type, trigger, limit, stop (with its
  structural basis), two profit targets, time barrier, reward:risk and slippage allowance.
- **Executive Summary** — the reasoning in plain sentences.
- **Meta-Model panel** — the classifier's raw probability, training sample count, base
  rate, in-sample accuracy, Brier score, and the features that pushed the call. Shown so
  the model can be doubted rather than trusted blindly.

**Price & Stage Structure.** Price with the 50-day and 30-week (150-day) moving averages,
volume histogram, and dashed overlays for the live trigger, stop and targets. The Stage
badge (1 Basing / 2 Advancing / 3 Topping / 4 Declining) is colour-coded. Range switches:
120d / 250d / 500d.

**Cluster Consensus.** A radar of average score per cluster, a bull/neutral/bear tally,
score dispersion, and a note of how many gatekeepers were excluded from the vote.

**Agent Breakdown.** One card per agent — score bar with centre origin, signal, confidence,
consensus weight and contribution. Expand for that agent's metrics, its full reasoning
trace, and where relevant a purpose-built visual (the fractional-differentiation
stationarity sweep, the correlation bars, the news list). Gatekeepers are labelled as
such and sort last.

**Walk-Forward Audit.** Runs the backtest on demand — see [Backtesting](#backtesting--audit).

---

### Tab 2 — My Portfolio

Where your holdings become actions.

**Add a holding.** Ticker, side, shares, entry, stop, optional target and thesis. Blur the
ticker field and it fetches the live quote and pre-fills a sensible entry and stop. It
shows the dollar risk between entry and stop as you type.

A **stop is mandatory**. The entire risk engine — heat, sizing, R-multiples, every exit
rule — is defined relative to where you get out. A position without one cannot be measured.

**Portfolio Review.** Press *Re-run review* and every active agent runs across every
holding. You get:

- **Headline** — one sentence: emergencies first, otherwise what needs attention, otherwise
  an explicit "no action required".
- **Seven metrics** — equity, cash, open P&L, deployed %, heat (against its limit),
  drawdown from peak, and total dollars at risk if every stop hit at once.
- **Diversification strip** (2+ holdings) — average pairwise correlation and the
  **effective number of independent bets**. Four holdings that behave like 1.4 bets is the
  single most useful number on the page.
- **Action list** — every alert, sorted by severity, each with a title, the evidence, and a
  concrete *What to do*. See the [alert catalogue](#portfolio-advisor).
- **Holdings table** — verdict badge (EXIT / TRIM / HOLD / ADD), shares, entry, current
  price, P&L, **R-multiple**, stage, RS rating, portfolio weight, and current stop with any
  suggested improvement (`140.00 → 193.47`). Two inline actions: **raise the stop** to the
  suggested level, or **close the position**.

**Risk & Stress modal** (via the header pill) — heat meter, allocation pie, the full N×N
correlation matrix colour-coded against the 0.70 veto threshold, and four scenario shocks
(NASDAQ −5%, −10%, a +50bp rate shock, VIX to 35) showing estimated P&L and which
positions would stop out.

---

### Tab 3 — Daily Picks

The screen: 52 liquid NASDAQ names, every active agent, ranked.

**Market breadth** sits on top — how many names are in each Weinstein stage, and a tone
(Broad advance / Mixed / Narrow / Defensive) with what it means for entries. Context first:
the same setup is worth more in a broad advance than a defensive tape.

**Ranked picks.** Each row shows rank, ticker, price, action, a rank-score bar, RS rating,
stage, reward:risk, detected pattern, and a `fresh breakout` flag. Expand for entry
trigger, stop, target, suggested size, allocation, P(profit), the rationale, and a
breakdown of **every component of the rank score** so a pick can be argued with. Two
buttons: full analysis, or add it straight to your portfolio at the suggested size.

**Strong, but held back.** Names that scored well but were stopped by a specific rule, with
the rule named (`CORRELATION_OVER_CONCENTRATION`, `VOLUME_UNCONFIRMED`, …). This category
exists so "good but blocked" is visible rather than silently dropped — the rule may clear.

**Avoid.** Stage 4 declines and deeply negative composites.

If nothing qualifies, it says so plainly. An empty list is a real answer.

---

## Data provenance

**Only price and volume can be real.** Everything else is generated locally, on every
setting. The UI states this rather than hiding it.

| Feed | With `yahoo` | With `synthetic` |
|------|--------------|------------------|
| Price / volume / benchmark | **Real** — daily bars, last completed session | Generated |
| Macro — VIX, VXN, 10Y, 3m bill, DXY, oil, gold | **Real** — live from Yahoo | Generated |
| Market breadth | **Real** — derived from the screening universe | Generated |
| Credit stress | **Real proxy** — 20-day HYG vs LQD | Generated |
| Fundamentals (EPS, float, sponsorship) | Generated | Generated |
| Options chain (put/call, IV, gamma) | Generated | Generated |
| News headlines | Generated | Generated |

Under `yahoo`:

- **8 agents run on real data** — Weinstein Stage, Chart Pattern, Volume/Order Flow,
  Relative Strength, Fractional Quant, Intermarket Macro, Portfolio Risk, Triple Barrier.
- **2 run on invented inputs** — Geopolitical News and Options Gamma. Their logic is
  sound; their premises are simulated. Both carry a `MODELLED` badge in the UI.
- **1 is mixed** — CAN SLIM: L/N/M use real price, C/A/S/I use generated fundamentals.

### Two honest labels in the macro feed

The field names encode their own caveats rather than overstating precision:

- **`yieldCurve3m10s`, not 2s10s.** Yahoo exposes no reliable 2-year series, and
  interpolating one would be fabrication dressed as data. The 3m/10y spread is a
  well-established recession indicator in its own right.
- **`creditStressProxy`, not an OAS.** The actual high-yield option-adjusted spread is a
  licensed series. This measures the same phenomenon — high yield underperforming
  investment grade — as 20-day relative performance of HYG against LQD, in percentage
  points, where a larger positive number means widening stress.

Breadth is computed across 30 names of the screening universe (percent above their own
50-day average, advancers vs decliners, net new 52-week highs) rather than taken from an
index provider — which makes it the real breadth of the names this system actually trades.
The macro snapshot is cached for 10 minutes.

Two further limits: Yahoo returns **daily bars from the last completed session**, so
nothing here is intraday or real-time. And it is an unofficial endpoint — no SLA, rate
limits, no commercial licence. Production needs a paid feed.

When live data is requested and a fetch fails, the request **errors with HTTP 502** rather
than substituting invented prices. `ALLOW_SYNTHETIC_FALLBACK=true` trades that strictness
for resilience, flagging the result `degraded`.

The **test suite deliberately stays on synthetic data** (it never loads `.env`), keeping
all 32 unit tests hermetic, offline and deterministic.

---

## The eleven agents

Every agent implements one contract — `analyze(ctx)` returning
`{ score: -100..100, confidence: 0..1, signal, reasoning[], metrics{}, payload{} }` — and
runs in isolation: a failing agent becomes an `ERROR` card and drops out of the consensus
rather than aborting the run.

| # | Agent | Cluster | What it computes |
|---|-------|---------|------------------|
| 1 | **CAN SLIM Growth** | Fundamental | All seven O'Neil letters graded separately: quarterly EPS vs the 25% floor, 3-year growth, catalyst + proximity to 52-week highs, float, 6-month relative performance, sponsorship change, market direction from the benchmark's 200-day MA |
| 2 | **Weinstein Stage** | Technical | 30-week MA on weekly bars, its slope in % per week, price position; prior trend separates a base (Stage 1) from a top (Stage 3). Source of the Stage 4 veto |
| 3 | **Chart Pattern** | Technical | Swing-pivot skeleton, then cup-with-handle, double bottom, head & shoulders (both polarities) and flat base — each with breakout level, measured-move target and invalidation |
| 4 | **Volume & Order Flow** | Technical | Most recent 50-day breakout and its volume vs the 20-day average (1.5× required), up/down volume ratio, pullback dry-up, tick-rule order-flow imbalance |
| 5 | **Relative Strength** | Technical | Mansfield RS vs QQQ, IBD-style 1–99 rating via a normal CDF on weighted relative performance, RS-line new highs, MACD/RSI state, bearish divergence |
| 6 | **Fractional Differentiation** | Quant | Sweeps d from 0.05 to 1.0 and picks the *minimum* order passing an ADF test — maximum memory subject to stationarity. Plus dollar bars and an aggressor metric |
| 7 | **Intermarket & Macro** | Macro | Live yields, DXY, VIX/VXN, 3m/10y curve, credit-stress proxy and universe breadth into a risk-on/off composite and a tech-multiple headwind score; runs the threat radar |
| 8 | **Geopolitical & News** | Sentiment | Recency-weighted sentiment (36-hour half-life) weighted for export controls, tariffs, supply chain and regulatory channels |
| 9 | **Options & Gamma** | Sentiment | Dealer gamma regime around the flip level, put/call as a contrarian signal at extremes, IV percentile and skew, call wall and put floor |
| 10 | **Portfolio Risk** | Risk | N×N correlation against open positions, portfolio heat, per-trade dollar ceiling, position-cap headroom. **Gatekeeper** |
| 11 | **Triple Barrier & Exit** | Execution | Volatility-adjusted target, structural stop (reaction low / rising 30-week MA) preferred over ATR, vertical time barrier. **Gatekeeper** |

### Voters vs gatekeepers

Risk and Execution agents **do not vote on direction**. A risk agent scoring +100 means
"this breaches no limit" — permission, not a reason to be long. Letting it vote would
inflate the composite of every idea analysed against an empty portfolio. They still veto
and still drive sizing.

---

## Decision pipeline

```
1. Quorum validation      minimum 3 active agents; cluster coverage recorded
2. Confidence matrix      score/100 × base weight × confidence × rolling performance
3. Entry resolution       where the order would actually fill
4. Veto engine            hard rules that cannot be outvoted
5. Meta-labelling         P(target before stop) from a fitted classifier
6. Kelly sizing           f* = (p(b+1)-1)/b, scaled and capped
7. Execution contract     order type, trigger, limit, stop, targets, time barrier
```

**Entry resolution precedes barrier construction**, and the ordering matters: a stop, a
target and a reward:risk ratio only mean anything relative to the price you actually get
filled at. Three modes:

- `STOP_LIMIT` — a breakout trigger sits ahead of spot and within 8%
- `LIMIT` — price is already through the trigger; enter at market
- `WATCH` — the trigger is more than 8% away. No order is generated; the levels shown are
  explicitly *projected*, anchored at the trigger. Buying a stop 30% above the market is
  how a detected pattern becomes a fictional entry.

### Veto rules

| Code | Severity | Trigger |
|------|----------|---------|
| `STAGE_4_VETO` | **BLOCK** | Long entry while Weinstein reports Stage 4 |
| `STAGE_2_SHORT_VETO` | **BLOCK** | Short against a confirmed Stage 2 advance |
| `PORTFOLIO_HEAT_BREACH` | **BLOCK** | Aggregate open risk at the 6% ceiling |
| `CORRELATION_OVER_CONCENTRATION` | **BLOCK** | Correlation > 0.70 to a *distinct* holding |
| `POSITION_CAP_REACHED` | **BLOCK** | Existing holding already fills the 5% ceiling |
| `REWARD_RISK_FLOOR` | **BLOCK** | Reward:risk below 1:1 |
| `STAGE_3_DISTRIBUTION` | ×0.35 | Topping pattern — no new longs |
| `VOLUME_UNCONFIRMED` | ×0.5 | Breakout below 1.5× average volume |
| `INTERMARKET_THREAT_RADAR` | ×0.5 | Yields spiking with VIX > 25 |
| `GEOPOLITICAL_EXTREME` | ×0.5 | Extreme supply-chain / conflict risk |
| `REWARD_RISK_SUBOPTIMAL` | ×0.6 | Reward:risk below the 1.8:1 target |

Downgrade multipliers compound; any BLOCK zeroes the size.

### Meta-labelling

The primary model decides **direction**; the meta-model decides **whether to take the bet
and how big**. It is a real logistic regression fitted at request time on the ticker's own
history, labelled by the triple-barrier method:

- Training samples stop one horizon before the present, so every label is fully observed —
  **no look-ahead**.
- Seven features standardised on the training set, same transform at inference.
- Reports training count, base rate, in-sample accuracy, Brier score and per-feature
  contributions, so its trustworthiness is visible.
- Degenerate cases (too few samples, single-class labels) fall back to the base rate rather
  than pretending to a fitted model.

Blended with the consensus prior in log-odds space: conviction and calibrated odds are
different quantities, and neither should size a trade alone.

### Position sizing

```
f* = (p(b+1) - 1) / b   →  × 0.25 (quarter-Kelly)  →  capped by:
                              1. per-trade risk ceiling (1% of equity)
                              2. absolute position ceiling (5% of equity)
                              3. remaining portfolio heat budget
```

Whichever binds first wins, and the response names it. A negative Kelly sizes to zero.
Stops are never placed closer than 0.8× ATR — a stop inside the noise band gets whipsawed
out by an ordinary session and flatters the reward:risk ratio.

---

## Portfolio Advisor

Runs the full pipeline over every holding and converts results into actions. Severity
ordering is deliberate: capital preservation outranks opportunity.

### Alert catalogue

| Severity | Code | Fires when |
|---|---|---|
| **CRITICAL** | `STOP_BREACHED` | Price is through your stop. Nothing else matters. |
| **CRITICAL** | `STAGE_4_BREAKDOWN` | Holding has entered a Stage 4 decline |
| **CRITICAL** | `PORTFOLIO_HEAT_BREACH` | Aggregate risk at the 6% ceiling |
| **CRITICAL** | `DRAWDOWN_DELEVERAGE` | Account 5%+ below peak — halve size until a new high |
| **WARNING** | `STAGE_3_DISTRIBUTION` | Advance stalling, MA flattening |
| **WARNING** | `TIME_BARRIER_EXPIRED` | Past its window and under 1R — dead money is a real cost |
| **WARNING** | `OVERSIZED_RISK` | Position risks more than 1.5× the per-trade policy |
| **WARNING** | `CONCENTRATION` | Position exceeds the single-idea ceiling |
| **WARNING** | `THESIS_DETERIORATING` | Consensus turned negative before any hard rule fired |
| **WARNING** | `CORRELATION_CLUSTER` | Two holdings correlate above 0.70 |
| **WARNING** | `PORTFOLIO_UNDIVERSIFIED` | Average pairwise correlation above 0.6 |
| **WARNING** | `PORTFOLIO_HEAT_ELEVATED` | Past 75% of the heat budget |
| **WARNING** | `LEVERAGE_IN_USE` | Gross exposure over 100% of equity |
| **OPPORTUNITY** | `TARGET_REACHED` | Profit target hit |
| **OPPORTUNITY** | `TRAIL_STOP` | Structure has moved up — raising the stop locks in gains |
| **OPPORTUNITY** | `ADD_TO_WINNER` | Every rule still passes and headroom remains |
| **INFO** | `LOW_DEPLOYMENT` | Under 20% deployed |

**Verdicts** are the strongest action implied: `EXIT` (breached stop or Stage 4), `TRIM`
(distribution, target, concentration, time barrier, oversized), `ADD`, else `HOLD`.

**Effective bets** = `N / (1 + (N-1) × average correlation)`. At an average correlation of
1.0 that collapses to 1 — which is the honest reading of a book that moves as one.

---

## Daily Picks

A name reaches the picks list only if it clears **every hard veto**. High conviction with a
blocking veto is not a "strong buy with a caveat" — it is not a buy.

Rank score components (all disclosed per pick):

| Component | Weight | Measures |
|---|---|---|
| `consensus` | 30% | Weighted agent composite |
| `probability` | 25% | Meta-model calibrated odds |
| `leadership` | 15% | RS rating |
| `stage` | 15% | Stage 2 only; fresh breakout scores highest |
| `volume` | 8% | Institutional participation |
| `rewardRisk` | 7% | Asymmetry of the actual trade |

Results cache for 15 minutes — a daily screen should behave like one. Screening runs at
concurrency 4 to avoid rate-limiting the data provider.

---

## Backtesting & audit

`POST /api/backtest` runs a rolling walk-forward (252-bar train / 63-bar test) reporting
**out-of-sample statistics only**, then a Monte Carlo permutation test: the return series
is shuffled and the identical rule re-run to build the null distribution.

The audit is deliberately unflattering. On sample data a 36.8% return with a 2.62 Sharpe is
reported `SPURIOUS` (p = 0.33) because the same rule earns ~25% on shuffled noise. A suite
that only confirms your strategy is worse than no suite at all.

Bias controls: no look-ahead, out-of-sample-only statistics, conservative tie-breaking (a
bar spanning both barriers scores as a stop), and an explicit in-sample vs out-of-sample
degradation figure.

---

## Accounts & security

- Passwords hashed with **scrypt** (`N=16384, r=8, p=1`) from node's crypto module —
  memory-hard, no native build, timing-safe verification.
- Sessions are **HS256 JWTs**, 30-day expiry. Set `JWT_SECRET` in production; it is
  mandatory when `NODE_ENV=production`.
- Login returns an identical response and comparable timing whether or not the account
  exists, so the endpoint cannot enumerate registered emails.
- The password hash is stripped from every serialised user object.
- Portfolio routes require authentication; analysis routes accept it optionally and fall
  back to a neutral default portfolio for sizing.
- Server-side validation refuses positions the engine would never propose (inverted stops,
  risk beyond the hard ceiling).

**Not hardened for public deployment.** There is no rate limiting, no HTTPS enforcement, no
CSRF protection, no email verification or password reset, and tokens live in
`localStorage`. Treat it as a local single-user tool until those are addressed.


---

## Deployment

A Render Blueprint ships at **`render.yaml`** in the repository root (the default path
Render looks for; point it elsewhere in the dashboard if you move it).

### One service, not two

The blueprint deploys a **single web service**. Express serves the REST API, the WebSocket
and the built React SPA from the same origin, which means:

- no CORS configuration to get wrong,
- the WebSocket inherits the page's host and TLS (`wss://`) automatically,
- no `VITE_API_BASE_URL` to keep in sync between environments.

Splitting it into a static site plus an API service would require all three, and buys
nothing at this size.

### Deploying

1. **Atlas — allow Render to connect.** In Atlas → *Network Access*, add `0.0.0.0/0`.
   Render's outbound IPs are dynamic on the free and starter plans, so an IP allowlist
   cannot work. Access is then controlled by the database user's credentials alone, which
   makes rotating a leaked password the only real remedy.
2. **Atlas — copy the connection string** and add the database name before the query
   string: `…mongodb.net/trading_app?retryWrites=true&w=majority`. Without it Mongoose
   silently writes to a database called `test`.
3. **Render → New → Blueprint**, point it at this repository.
4. Render prompts for **`MONGO_URI`** (declared `sync: false`, so it is never stored in
   git). Paste the string from step 2. **`JWT_SECRET`** is generated automatically and held
   stable across deploys, so sessions survive a redeploy.
5. Deploy. `/api/health` is the health check; the service restarts if it stops returning
   2xx.

### What the blueprint sets

| Variable | Source | Why |
|---|---|---|
| `MONGO_URI` | **dashboard** (`sync: false`) | A connection string is a credential and this repo is public |
| `JWT_SECRET` | **generated** by Render | Strong, stable, nobody has to invent one |
| `NODE_ENV` | `production` | Makes `JWT_SECRET` mandatory and the database non-optional |
| `MARKET_DATA_PROVIDER` | `yahoo` | Real daily prices and macro |
| `ALLOW_SYNTHETIC_FALLBACK` | `false` | Fail loudly rather than serve invented prices |
| `NODE_VERSION` | `22` | Pinned so a Render default bump cannot break the build |

### Two production behaviours that differ from development

- **The database is no longer optional.** In development a missing MongoDB degrades to an
  in-memory store. In production that is not graceful degradation, it is silent data loss —
  every account and position would vanish on the next restart — so the server refuses to
  start without a reachable database.
- **`JWT_SECRET` is mandatory.** Development derives a stable per-machine value; production
  throws without one, so tokens can never be signed with a guessable key.

### Free plan caveats

Render's free tier sleeps after ~15 minutes idle, so the first request afterwards waits for
a cold start (and the screener's first run then repopulates its caches). Upgrade to
`starter` in `render.yaml` to keep it warm.

---

## API reference

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `POST` | `/api/auth/register` | — | Create an account, returns a token |
| `POST` | `/api/auth/login` | — | Sign in |
| `GET` | `/api/auth/me` | required | Current user + portfolio summary |
| `GET` | `/api/health` | — | Status, drivers, agent count |
| `GET` | `/api/agents` | — | Agent registry with rolling performance |
| `GET` | `/api/pipeline` | — | Machine-readable pipeline description |
| `POST` | `/api/analyze` | optional | Full decision for one ticker |
| `POST` | `/api/analyze/batch` | optional | Watchlist screener (≤25) |
| `GET` | `/api/picks` | optional | Ranked daily candidates |
| `GET` | `/api/chart/:ticker` | optional | OHLCV with MA overlays |
| `GET` | `/api/market/overview` | optional | Quotes + macro + provenance |
| `POST` | `/api/backtest` | optional | Walk-forward + permutation test |
| `GET` | `/api/logs` | optional | Decision audit trail |
| `GET` | `/api/portfolio` | required | Portfolio marked to market |
| `POST` | `/api/portfolio/positions` | required | Open a position |
| `PATCH` | `/api/portfolio/positions/:id` | required | Amend (raise stop, trim) |
| `DELETE` | `/api/portfolio/positions/:id` | required | Close a position |
| `GET` | `/api/portfolio/review` | required | Full advisor review |
| `GET` | `/api/portfolio/stress-test` | required | Correlation matrix + scenarios |

WebSocket at `/ws`: send `{ type: "subscribe", tickers: [...] }` for `quotes` frames and
mirrored orchestration events.

---

## Configuration

`backend/.env`:

| Variable | Default | Effect |
|---|---|---|
| `MARKET_DATA_PROVIDER` | `yahoo` | `yahoo` (real daily bars) or `synthetic` (offline) |
| `ALLOW_SYNTHETIC_FALLBACK` | `false` | Whether a failed live fetch may substitute generated prices |
| `MONGO_URI` | localhost | Local mongod or an Atlas SRV string. Include the database name. Optional in dev, **required in production** |
| `EVENT_BUS` | `memory` | `memory` or `kafka` |
| `JWT_SECRET` | dev-derived | **Required** in production |
| `MAX_RISK_PER_TRADE_PCT` | `1.0` | Per-idea risk ceiling |
| `HARD_MAX_POSITION_PCT` | `5.0` | Single-idea position ceiling |
| `MAX_PORTFOLIO_HEAT_PCT` | `6.0` | Aggregate open-risk ceiling |
| `KELLY_FRACTION` | `0.25` | Quarter-Kelly |

Every external dependency degrades independently: no Mongo means an in-memory store, no
Kafka means an in-process EventEmitter, no network means synthetic data.

---

## Testing

```bash
npm test        # 32 unit tests, hermetic and offline (~150ms)
npm run smoke   # 29 API tests against a running server
```

Coverage includes the Kelly identities, every veto rule, barrier geometry (both
directions), the minimum-stop rule, quorum enforcement, fractional-differentiation
stationarity, synthetic-data determinism, advisor alert priority, screener veto
compliance, auth rejection paths, macro schema compatibility between the live and generated
snapshots, and the invariant that a profit target always sits beyond its entry.

---

## Scope notes

- **Eleven agents are implemented.** The wider taxonomy (Financial Health, Earnings
  Quality, Statistical Arbitrage, Rule Validator, Market Regime, Market Tone, Social NLP,
  Information Bars, Execution Timing) is not built. The registry is one list in
  `agents/index.js` — adding one means writing the class and adding a line.
- **Camunda**: a Camunda-compatible BPMN 2.0 definition ships in
  `backend/workflow/manager-decision.bpmn` (external-task topics on every service task,
  validated well-formed) mirrored by `decisionPipeline.js`. Execution defaults to the
  in-process orchestrator: the pipeline is a sub-second synchronous fan-out with no
  human-in-the-loop steps, so a BPMN engine would add infrastructure and latency without
  buying anything yet. Deploy it when you need external workers or approval gates.
- **RAG**: the qualitative agents consume a normalised `ctx.news` feed — that is the seam
  where a retrieval pipeline over live news and EDGAR filings attaches. No LLM calls are
  made; every agent is deterministic and unit-testable, which is why the suite runs in
  ~100ms.
- **Fundamentals, options and news are still modelled**, not fetched. Those three require
  paid or keyed entitlements (a fundamentals API, an options chain provider, a news feed).
  Macro was moved to live data because it could be assembled from free, unauthenticated
  sources; these cannot. Swap the generators in `data/marketDataService.js` for real
  providers without touching an agent.

**This is analytical software, not investment advice.** It places no orders and connects to
no broker. Backtested and synthetic results are not predictive of live performance.
