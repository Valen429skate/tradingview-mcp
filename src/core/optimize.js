/**
 * Core strategy-optimizer logic — grid search over a strategy's inputs using
 * the live Strategy Tester. For each combination: set inputs → wait for the
 * report to recompute → read metrics. Original inputs are restored afterwards
 * (or the best combination is applied when apply_best is true).
 */
import { getIndicator as _getIndicator, getStrategyResults as _getStrategyResults } from './data.js';
import { setInputs as _setInputs } from './indicators.js';

const MAX_COMBINATIONS = 100;
// Metrics where smaller is better; everything else ranks descending.
const ASCENDING = new Set(['max_drawdown', 'max_drawdown_percent', 'losing_trades', 'commission_paid']);

export function cartesian(params) {
  const keys = Object.keys(params);
  if (!keys.length) return [];
  let combos = [{}];
  for (const k of keys) {
    const vals = Array.isArray(params[k]) ? params[k] : [params[k]];
    if (!vals.length) throw new Error(`Parameter "${k}" has no values`);
    const next = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [k]: v });
    combos = next;
  }
  return combos;
}

/** Expand {start, stop, step} range specs into arrays. */
export function expandRanges(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'start' in v && 'stop' in v) {
      const step = v.step == null ? 1 : Number(v.step);
      if (!(step > 0)) throw new Error(`step for "${k}" must be > 0`);
      const dp = (String(step).split('.')[1] || '').length;
      const arr = [];
      for (let x = Number(v.start); x <= Number(v.stop) + 1e-9; x += step) arr.push(Number(x.toFixed(dp)));
      out[k] = arr;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function rankResults(results, metric, minTrades = 0) {
  const asc = ASCENDING.has(metric);
  return results
    .filter(r => r.metrics && typeof r.metrics[metric] === 'number' && (r.metrics.total_trades ?? 0) >= minTrades)
    .sort((a, b) => (asc ? a.metrics[metric] - b.metrics[metric] : b.metrics[metric] - a.metrics[metric]));
}

export async function optimize({ entity_id, params: rawParams, metric = 'net_profit', min_trades = 0, apply_best = false, settle_ms = 2000, top = 10, _deps } = {}) {
  const getIndicator = _deps?.getIndicator || _getIndicator;
  const getStrategyResults = _deps?.getStrategyResults || _getStrategyResults;
  const setInputs = _deps?.setInputs || _setInputs;
  const sleep = _deps?.sleep || (ms => new Promise(r => setTimeout(r, ms)));

  if (!entity_id) throw new Error('entity_id is required (strategy ID from chart_get_state)');
  const params = expandRanges(typeof rawParams === 'string' ? JSON.parse(rawParams) : (rawParams || {}));
  const combos = cartesian(params);
  if (!combos.length) throw new Error('params must map input ids to value arrays, e.g. {"in_0": [10, 20, 30]}');
  if (combos.length > MAX_COMBINATIONS) throw new Error(`${combos.length} combinations exceeds the limit of ${MAX_COMBINATIONS}. Narrow the ranges.`);

  const info = await getIndicator({ entity_id });
  const inputIds = new Set((info.inputs || []).map(i => i.id));
  const unknown = Object.keys(params).filter(k => !inputIds.has(k));
  if (unknown.length) {
    throw new Error(`Unknown input id(s): ${unknown.join(', ')}. Available: ${[...inputIds].filter(id => id !== 'text' && id !== 'pineId' && id !== 'pineVersion').join(', ')}`);
  }
  const original = Object.fromEntries((info.inputs || []).filter(i => i.id in params).map(i => [i.id, i.value]));

  const results = [];
  try {
    for (const combo of combos) {
      try {
        await setInputs({ entity_id, inputs: combo });
        await sleep(settle_ms);
        const res = await getStrategyResults();
        results.push({ inputs: combo, metrics: res.metrics, ...(res.error && { error: res.error }) });
      } catch (err) {
        results.push({ inputs: combo, error: err.message });
      }
    }
  } finally {
    // Always leave the strategy in a known state, even when a run throws.
    const ranked = rankResults(results, metric, min_trades);
    const final = apply_best && ranked.length ? ranked[0].inputs : original;
    try { await setInputs({ entity_id, inputs: final }); } catch { /* best effort */ }
  }

  const ranked = rankResults(results, metric, min_trades);
  const slim = (r) => ({
    inputs: r.inputs,
    [metric]: r.metrics[metric],
    net_profit: r.metrics.net_profit,
    profit_factor: r.metrics.profit_factor,
    max_drawdown: r.metrics.max_drawdown,
    total_trades: r.metrics.total_trades,
    percent_profitable: r.metrics.percent_profitable,
  });
  return {
    success: ranked.length > 0,
    metric, combinations_tested: combos.length, valid_results: ranked.length,
    best: ranked[0] ? slim(ranked[0]) : null,
    top: ranked.slice(0, Math.max(1, top)).map(slim),
    original_inputs: original,
    applied: apply_best && ranked.length ? 'best' : 'original',
    errors: results.filter(r => r.error).slice(0, 5).map(r => ({ inputs: r.inputs, error: r.error })),
    note: 'Results are in-sample. Validate the best inputs on a different date range (chart_set_visible_range / replay) to avoid overfitting.',
  };
}
