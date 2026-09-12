// Caveat generation.
//
// Every signal number the UI shows gets the measured reason to doubt it placed
// beside it. Nothing here is hand-written opinion: each caveat is derived from
// either the decision itself (meta-model validation, data provenance) or from
// config/calibration.json, which `npm run calibrate` regenerates by measuring
// the system across the whole universe. The calibration date travels with the
// caveats so a stale measurement is visible as stale.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLUSTERS } from '../config/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CALIBRATION_PATH = path.resolve(__dirname, '../config/calibration.json');

let calibration = null;
let calibrationLoadedAt = 0;

export function loadCalibration() {
  // Re-read at most once a minute so a fresh `npm run calibrate` is picked up
  // without a restart.
  if (calibration && Date.now() - calibrationLoadedAt < 60_000) return calibration;
  try {
    calibration = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
  } catch {
    calibration = null;
  }
  calibrationLoadedAt = Date.now();
  return calibration;
}

/** Effective number of independent opinions among the given voting agents. */
export function effectiveOpinions(agentIds, cal = loadCalibration()) {
  const M = cal?.agentRedundancy?.correlationMatrix;
  if (!M) return null;
  const ids = agentIds.filter((id) => M[id]);
  const n = ids.length;
  if (!n) return null;
  let total = 0;
  for (const a of ids) for (const b of ids) total += Math.abs(M[a]?.[b] ?? (a === b ? 1 : 0));
  return Number(((n * n) / total).toFixed(1));
}

const SEV = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };

/**
 * @returns {Array<{code, severity, appliesTo, title, detail}>}
 *   appliesTo: 'probability' | 'composite' | 'pattern' | 'agent:<id>' | 'system'
 */
export function buildCaveats({ meta, consensus, agentResults, dataSources, direction }) {
  const cal = loadCalibration();
  const caveats = [];
  const calDate = cal ? cal.generatedAt.slice(0, 10) : null;

  /* ---- P(profit): what the meta-model's own validation says ---- */
  if (meta && direction !== 0) {
    const v = meta.validation;
    const eff = meta.effectiveSamples;
    if (meta.method === 'BASE_RATE' || !v) {
      caveats.push({
        code: 'PROBABILITY_IS_BASE_RATE', severity: SEV.HIGH, appliesTo: 'probability',
        title: 'This is the historical base rate, not a prediction',
        detail: meta.note || 'No model could be fitted for this name; the figure is simply the share of past setups that reached their target.',
      });
    } else if (v.verdict === 'NO_SKILL') {
      caveats.push({
        code: 'META_MODEL_NO_SKILL', severity: SEV.HIGH, appliesTo: 'probability',
        title: 'The model failed out-of-sample validation for this name',
        detail: `${v.summary} Fitted value was ${(meta.fittedProbability * 100).toFixed(0)}%; the number shown is the base rate.`,
      });
    } else if (v.verdict === 'WEAK') {
      caveats.push({
        code: 'META_MODEL_WEAK', severity: SEV.MEDIUM, appliesTo: 'probability',
        title: 'Weak out-of-sample skill — heavily shrunk toward the base rate',
        detail: v.summary,
      });
    } else if (v.verdict === 'UNVALIDATED') {
      caveats.push({
        code: 'META_MODEL_UNVALIDATED', severity: SEV.HIGH, appliesTo: 'probability',
        title: 'Could not be validated out-of-sample',
        detail: v.summary,
      });
    }
    if (eff != null && eff < 100) {
      caveats.push({
        code: 'SMALL_EFFECTIVE_SAMPLE', severity: eff < 30 ? SEV.HIGH : SEV.MEDIUM, appliesTo: 'probability',
        title: `Only ~${Math.round(eff)} effectively independent observations`,
        detail: `${meta.trainingSamples.toLocaleString('en-US')} training labels, but with ${meta.horizonDays}-day overlapping windows they contain roughly ${Math.round(eff)} independent outcomes. Treat any probability from this few as a rough prior.`,
      });
    }
  }

  /* ---- Composite: how many opinions is it really? ---- */
  const voterIds = (agentResults || [])
    .filter((r) => r.status === 'COMPLETE' && ![CLUSTERS.RISK, CLUSTERS.EXECUTION].includes(r.cluster))
    .map((r) => r.agentId);
  const effOpinions = effectiveOpinions(voterIds, cal);
  if (effOpinions != null && voterIds.length >= 2) {
    const ratio = effOpinions / voterIds.length;
    caveats.push({
      code: 'AGENTS_CORRELATED', severity: ratio < 0.5 ? SEV.HIGH : ratio < 0.75 ? SEV.MEDIUM : SEV.LOW, appliesTo: 'composite',
      title: `${voterIds.length} voting agents ≈ ${effOpinions} independent opinions`,
      detail: `Measured across ${cal.decisionsSampled} names on ${calDate}, the trend-following agents move together (${cal.agentRedundancy.mostRedundantPairs.slice(0, 2).map((p) => `${short(p.a)}/${short(p.b)} r=${p.r}`).join(', ')}). Broad agreement is mostly one view restated.`,
    });
  }

  /* ---- Pattern: how selective is the detector? ---- */
  const pattern = agentResults?.find((r) => r.agentId === 'Chart_Pattern_Agent')?.payload?.pattern;
  const rate = pattern && cal?.patternDetectionRates?.[pattern];
  if (pattern && rate != null) {
    caveats.push({
      code: 'PATTERN_DETECTION_RATE', severity: rate > 0.4 ? SEV.HIGH : rate > 0.2 ? SEV.MEDIUM : SEV.LOW, appliesTo: 'pattern',
      title: `"${pattern}" was detected in ${(rate * 100).toFixed(0)}% of the universe`,
      detail: rate > 0.4
        ? 'A pattern found in most charts carries almost no information — the detector is labelling ordinary price movement, not recognising a rare structure.'
        : rate > 0.2
          ? 'Common enough that it is weak evidence on its own.'
          : 'Rare enough to be meaningful, though its forward returns have not been validated separately.',
    });
  }

  /* ---- Inputs that are not real ---- */
  const modelledAgents = (agentResults || []).filter((r) => {
    const feed = { Intermarket_Macro_Agent: 'macro', Geopolitical_News_Agent: 'news', Options_Sentiment_Agent: 'options', CAN_SLIM_Agent: 'fundamentals' }[r.agentId];
    return feed && dataSources?.[feed] === 'MODELLED';
  });
  if (modelledAgents.length) {
    caveats.push({
      code: 'MODELLED_INPUTS', severity: SEV.HIGH, appliesTo: 'composite',
      title: `${modelledAgents.length} contributing agent${modelledAgents.length === 1 ? '' : 's'} read generated, not observed, data`,
      detail: `${modelledAgents.map((a) => a.agentName).join(', ')}. Their reasoning is coherent; their premises are simulated. Their votes are included in the composite.`,
    });
  }

  /* ---- The system-level truth ---- */
  const sv = cal?.strategyValidation;
  if (sv) {
    caveats.push({
      code: 'STRATEGY_VS_BUY_AND_HOLD', severity: SEV.HIGH, appliesTo: 'system',
      title: `Over ${sv.period?.from?.slice(0, 4)}–${sv.period?.to?.slice(0, 4)}, the primary rule beat buy-and-hold on ${sv.tickersBeatingBuyAndHold} of ${sv.tickersCompared} names`,
      detail: `Median CAGR ${sv.medianCagr.strategy}% vs ${sv.medianCagr.buyHold}% for simply holding; median max drawdown ${sv.medianMaxDrawdown.strategy}% vs ${sv.medianMaxDrawdown.buyHold}%. The per-trade edge is statistically real (${sv.trades.toLocaleString('en-US')} trades, 95% CI [${sv.bootstrapCi95?.[0]}%, ${sv.bootstrapCi95?.[1]}%]) but it reduces drawdown rather than adding return. ${sv.survivorshipBias}`,
    });
  }

  if (!cal) {
    caveats.push({
      code: 'NOT_CALIBRATED', severity: SEV.HIGH, appliesTo: 'system',
      title: 'System has not been calibrated',
      detail: 'Run `npm run calibrate` to measure agent redundancy, pattern rates and strategy performance. Until then, treat every signal as unvalidated.',
    });
  }

  return caveats;
}

const short = (id) => id.replace('_Agent', '').replace(/_/g, ' ');
