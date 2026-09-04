import { SIGNALS } from '../config/constants.js';
import { clamp } from '../lib/stats.js';

/**
 * Every agent is an independent analytical unit with one contract:
 *
 *   analyze(ctx) -> { score, confidence, reasoning[], metrics{}, payload{} }
 *
 * `run()` wraps that with timing, normalisation and error isolation — a single
 * throwing agent degrades to an ERROR card in the UI and is excluded from the
 * consensus, it never takes down the orchestration run.
 *
 * `payload` carries structured facts the orchestrator's veto/sizing stages read
 * directly (stage number, volume confirmation, barrier prices, ...), keeping
 * those couplings explicit rather than string-matching on reasoning text.
 */
export class BaseAgent {
  constructor({ id, name, cluster, description, weight = 1.0 }) {
    this.id = id;
    this.name = name;
    this.cluster = cluster;
    this.description = description;
    this.weight = weight;
  }

  // eslint-disable-next-line no-unused-vars
  async analyze(ctx) {
    throw new Error(`${this.id}: analyze() not implemented`);
  }

  async run(ctx) {
    const started = Date.now();
    try {
      const raw = await this.analyze(ctx);
      const score = clamp(Number(raw.score) || 0, -100, 100);
      const confidence = clamp(Number(raw.confidence ?? 0.5), 0, 1);
      return {
        agentId: this.id,
        agentName: this.name,
        cluster: this.cluster,
        status: 'COMPLETE',
        score: Number(score.toFixed(1)),
        confidence: Number(confidence.toFixed(3)),
        signal: raw.signal || scoreToSignal(score),
        reasoning: raw.reasoning || [],
        metrics: raw.metrics || {},
        payload: raw.payload || {},
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      return {
        agentId: this.id,
        agentName: this.name,
        cluster: this.cluster,
        status: 'ERROR',
        score: 0,
        confidence: 0,
        signal: SIGNALS.NEUTRAL,
        reasoning: [`Agent failed: ${err.message}`],
        metrics: {},
        payload: {},
        error: err.message,
        elapsedMs: Date.now() - started,
      };
    }
  }
}

export function scoreToSignal(score, threshold = 20) {
  if (score >= threshold) return SIGNALS.BULLISH;
  if (score <= -threshold) return SIGNALS.BEARISH;
  return SIGNALS.NEUTRAL;
}

/**
 * Maps a raw measurement onto a bounded contribution.
 * Below `bad` scores `-max`, above `good` scores `+max`, linear in between.
 */
export function gradeLinear(value, bad, good, max = 100) {
  if (!Number.isFinite(value)) return 0;
  if (good === bad) return 0;
  const t = (value - bad) / (good - bad);
  return clamp(t * 2 - 1, -1, 1) * max;
}
