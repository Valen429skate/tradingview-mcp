/**
 * One-call chart analysis: trend, structure, momentum, candle patterns, key
 * levels and (optionally) multi-timeframe alignment are combined into a single
 * confluence score with human-readable reasons and a suggested trade plan.
 *
 * scoreConfluence() and buildPlan() are pure; analyzeChart() fetches bars.
 */
import * as ta from './ta.js';
import { computeKeyLevels, multiTimeframe as _multiTimeframe } from './analysis.js';
import { detectCandles, marketStructure } from './patterns.js';
import { calcPositionSize } from './risk.js';
import { getOhlcv as _getOhlcv } from './data.js';
import { regime as detectRegime, divergences } from './signals.js';
import { liquiditySweeps } from './smc.js';
import { buildZones, planFromZones } from './zones.js';

const TREND_PTS = { strong_up: 25, up: 15, neutral: 0, down: -15, strong_down: -25, insufficient_data: 0 };
// Human-friendly number for reason strings (prices, indicator values).
const n = (v) => (v == null ? '—' : Math.abs(v) >= 1 ? ta.round(v, 2) : ta.round(v, 6));

const MTF_PTS = { bullish_aligned: 20, leaning_bullish: 10, mixed: 0, leaning_bearish: -10, bearish_aligned: -20 };

export function scoreConfluence({ snap, structure, patterns, levels, mtf, extras }) {
  const f = [];
  const add = (points, reason) => { if (points) f.push({ points, reason }); };

  add(TREND_PTS[snap.trend] ?? 0, `EMA trend is ${snap.trend.replace('_', ' ')} (close ${n(snap.close)} vs EMA20 ${n(snap.ema20)}, EMA50 ${n(snap.ema50)}${snap.ema200 != null ? `, EMA200 ${n(snap.ema200)}` : ''})`);
  if (structure.structure === 'uptrend') add(15, 'Market structure: higher highs and higher lows');
  if (structure.structure === 'downtrend') add(-15, 'Market structure: lower highs and lower lows');
  if (structure.break_of_structure) add(structure.break_of_structure.direction === 'bullish' ? 10 : -10, `Break of structure ${structure.break_of_structure.direction} through ${n(structure.break_of_structure.level)}`);

  if (snap.macd_hist != null) add(snap.macd_hist > 0 ? 8 : -8, `MACD histogram ${snap.macd_hist > 0 ? 'positive' : 'negative'} (${n(snap.macd_hist)})`);
  if (snap.rsi != null) {
    if (snap.rsi >= 75) add(-6, `RSI ${n(snap.rsi)} — overbought, late to buy`);
    else if (snap.rsi <= 25) add(6, `RSI ${n(snap.rsi)} — oversold, late to sell`);
    else if (snap.rsi > 55) add(6, `RSI ${n(snap.rsi)} — bullish momentum`);
    else if (snap.rsi < 45) add(-6, `RSI ${n(snap.rsi)} — bearish momentum`);
  }

  const recent = patterns.filter(p => p.bars_ago <= 3 && p.bias !== 'neutral');
  let patPts = 0;
  for (const p of recent) patPts += p.bias === 'bullish' ? 8 : -8;
  patPts = Math.max(-16, Math.min(16, patPts));
  if (patPts) add(patPts, `Recent candle patterns: ${recent.map(p => `${p.pattern} (${p.bars_ago === 0 ? 'this bar' : p.bars_ago === 1 ? '1 bar ago' : `${p.bars_ago} bars ago`})`).join(', ')}`);

  const atr = levels.atr || snap.atr;
  if (atr && levels.nearest_support != null && snap.close - levels.nearest_support < 0.5 * atr) add(8, `Price sitting on support ${n(levels.nearest_support)}`);
  if (atr && levels.nearest_resistance != null && levels.nearest_resistance - snap.close < 0.5 * atr) add(-8, `Price pressing into resistance ${n(levels.nearest_resistance)}`);
  if (snap.rel_volume != null && snap.rel_volume >= 1.8) add(Math.sign(snap.change_pct || 0) * 5, `Volume ${n(snap.rel_volume)}× average on a ${snap.change_pct > 0 ? 'up' : 'down'} bar`);

  if (mtf?.alignment) add(MTF_PTS[mtf.alignment.bias] ?? 0, `Higher timeframes: ${mtf.alignment.bias.replace('_', ' ')} (${mtf.alignment.up_count} up / ${mtf.alignment.down_count} down)`);

  // Professional signals (optional — present when analyzeChart computes them).
  if (extras) {
    const { regime: rg, divs, sweeps } = extras;
    if (rg?.supertrend) add(rg.supertrend.direction === 'up' ? 6 : -6, `Supertrend ${rg.supertrend.direction} (flip level ${n(rg.supertrend.level)})`);
    if (rg?.adx != null && rg.adx >= 25) add(rg.plus_di > rg.minus_di ? 6 : -6, `ADX ${n(rg.adx)} — strong trend, ${rg.plus_di > rg.minus_di ? '+DI' : '−DI'} in control`);
    for (const d of (divs || []).filter(x => x.confirmed_bars_ago <= 8).slice(0, 2)) {
      add(d.bias === 'bullish' ? (d.type.startsWith('regular') ? 8 : 5) : (d.type.startsWith('regular') ? -8 : -5), `${d.type.replace('_', ' ')} ${d.oscillator.toUpperCase()} divergence (price ${n(d.price_from)}→${n(d.price_to)})`);
    }
    const sw = (sweeps || []).find(x => x.bars_ago <= 5);
    if (sw) add(sw.type === 'bullish' ? 8 : -8, `Liquidity sweep: ${sw.type === 'bullish' ? 'lows' : 'highs'} at ${n(sw.swept_level)} taken and rejected ${sw.bars_ago} bars ago`);
  }

  const score = Math.max(-100, Math.min(100, f.reduce((s, x) => s + x.points, 0)));
  let verdict = 'neutral';
  if (score >= 40) verdict = 'strong_bullish';
  else if (score >= 15) verdict = 'bullish';
  else if (score <= -40) verdict = 'strong_bearish';
  else if (score <= -15) verdict = 'bearish';
  return {
    score, verdict,
    bullish_factors: f.filter(x => x.points > 0).sort((a, b) => b.points - a.points),
    bearish_factors: f.filter(x => x.points < 0).sort((a, b) => a.points - b.points),
  };
}

/** Suggested plan: stop beyond the nearest level (or ATR), targets at next levels (or R multiples). */
export function buildPlan({ verdict, snap, levels }, { account_size, risk_percent, point_value, qty_step } = {}) {
  if (!verdict.includes('bull') && !verdict.includes('bear')) {
    return {
      action: 'wait',
      reason: 'No clear edge — conflicting signals.',
      watch: { breakout_above: levels.nearest_resistance, breakdown_below: levels.nearest_support },
    };
  }
  const long = verdict.includes('bull');
  const dir = long ? 1 : -1;
  const atr = levels.atr || snap.atr;
  const entry = snap.close;
  const nearLevel = long ? levels.support?.[0] : levels.resistance?.[0];
  let stop, stopBasis;
  if (nearLevel && Math.abs(entry - nearLevel.price) <= 3 * atr) {
    stop = long ? nearLevel.zone_low - 0.25 * atr : nearLevel.zone_high + 0.25 * atr;
    stopBasis = `beyond ${long ? 'support' : 'resistance'} zone ${n(nearLevel.price)} + 0.25 ATR buffer`;
  } else {
    stop = entry - dir * 1.5 * atr;
    stopBasis = '1.5 × ATR (no nearby level)';
  }
  const risk = Math.abs(entry - stop);
  const opposite = (long ? levels.resistance : levels.support) || [];
  let targets = opposite.map(z => z.price).filter(p => (p - entry) * dir >= risk).slice(0, 2);
  let targetBasis = 'next key levels';
  if (!targets.length) { targets = [entry + dir * 2 * risk, entry + dir * 3 * risk]; targetBasis = '2R / 3R (no levels far enough)'; }

  const plan = {
    action: long ? 'look_for_long' : 'look_for_short',
    entry: ta.round(entry, 8), stop: ta.round(stop, 8), stop_basis: stopBasis,
    targets: targets.map(t => ({ price: ta.round(t, 8), r_multiple: ta.round(((t - entry) * dir) / risk, 2) })),
    target_basis: targetBasis,
    invalidation: `${long ? 'Close below' : 'Close above'} ${n(stop)}`,
  };
  if (account_size) {
    const sized = calcPositionSize({ account_size, risk_percent, point_value, qty_step, entry, stop, targets });
    plan.position = { quantity: sized.quantity, actual_risk: sized.actual_risk, actual_risk_pct: sized.actual_risk_pct, notional: sized.notional, ...(sized.warnings && { warnings: sized.warnings }) };
  }
  return plan;
}

export async function analyzeChart({ count, include_mtf = false, timeframes, account_size, risk_percent, point_value, qty_step, _deps } = {}) {
  const getOhlcv = _deps?.getOhlcv || _getOhlcv;
  const multiTimeframe = _deps?.multiTimeframe || _multiTimeframe;
  const { bars } = await getOhlcv({ count: Math.min(count || 500, 500) });
  if (!bars || bars.length < 60) throw new Error('Need at least 60 bars for a full analysis');

  const snap = ta.snapshot(bars);
  const levels = computeKeyLevels(bars);
  const structure = marketStructure(bars);
  const patterns = detectCandles(bars, { lookback: 10 });
  let mtf = null;
  if (include_mtf) { try { mtf = await multiTimeframe({ timeframes }); } catch (err) { mtf = { error: err.message }; } }

  const rg = detectRegime(bars);
  const divs = [...divergences(bars, { oscillator: 'rsi', recent: 15 }), ...divergences(bars, { oscillator: 'macd', recent: 15 })];
  const sweeps = liquiditySweeps(bars, { lookback: 10 });
  const conf = scoreConfluence({ snap, structure, patterns, levels, mtf: mtf?.alignment ? mtf : null, extras: { regime: rg, divs, sweeps } });
  const plan = buildPlan({ verdict: conf.verdict, snap, levels }, { account_size, risk_percent, point_value, qty_step });

  // Precise limit-order plan from confluence zones, in the verdict's direction.
  let precise = null;
  if (plan.action !== 'wait') {
    try {
      const zones = buildZones(bars);
      precise = planFromZones(bars, zones, { side: plan.action === 'look_for_long' ? 'long' : 'short' });
      if (account_size && precise.entry != null) {
        const sized = calcPositionSize({ account_size, risk_percent, point_value, qty_step, entry: precise.entry, stop: precise.stop, targets: precise.targets.map(t => t.price) });
        precise.position = { quantity: sized.quantity, actual_risk: sized.actual_risk, actual_risk_pct: sized.actual_risk_pct, ...(sized.warnings && { warnings: sized.warnings }) };
      }
    } catch (err) { precise = { error: err.message }; }
  }
  // Counter-regime warning: trend verdict inside a range, or a fade inside a strong trend.
  const regimeNote = rg.state === 'ranging' && /strong/.test(conf.verdict)
    ? 'Market is ranging — trend signals are less reliable; prefer limit entries at range extremes.'
    : rg.state.startsWith('trending') && ((rg.state.endsWith('up') && conf.verdict.includes('bear')) || (rg.state.endsWith('down') && conf.verdict.includes('bull')))
      ? 'Verdict is AGAINST the prevailing trend — counter-trend trade: smaller size, quicker targets.'
      : null;

  return {
    success: true,
    verdict: conf.verdict,
    score: conf.score,
    summary: `${conf.verdict.replace('_', ' ').toUpperCase()} (${conf.score > 0 ? '+' : ''}${conf.score}/100) — ${conf.bullish_factors.length} bullish vs ${conf.bearish_factors.length} bearish factors`,
    bullish_factors: conf.bullish_factors,
    bearish_factors: conf.bearish_factors,
    plan,
    ...(precise && { precise_entry: precise }),
    regime: { state: rg.state, trend_strength: rg.trend_strength, adx: rg.adx, choppiness: rg.choppiness, supertrend: rg.supertrend, playbook: rg.playbook, ...(regimeNote && { warning: regimeNote }) },
    divergences: divs.filter(d => d.bars_ago <= 15).slice(0, 4),
    ...(sweeps.length && { liquidity_sweeps: sweeps.slice(0, 3) }),
    snapshot: { close: snap.close, change_pct: snap.change_pct, rsi: snap.rsi, atr: snap.atr, atr_pct: snap.atr_pct, trend: snap.trend, ema20: snap.ema20, ema50: snap.ema50, ema200: snap.ema200, rel_volume: snap.rel_volume },
    structure: { structure: structure.structure, break_of_structure: structure.break_of_structure, last_swing_high: structure.last_swing_high, last_swing_low: structure.last_swing_low },
    levels: { nearest_support: levels.nearest_support, nearest_resistance: levels.nearest_resistance, pivots: levels.pivots, previous_period: levels.previous_period },
    recent_patterns: patterns.filter(p => p.bars_ago <= 5),
    ...(mtf && { multi_timeframe: mtf.alignment ? { alignment: mtf.alignment, timeframes: mtf.timeframes.map(t => ({ timeframe: t.timeframe, trend: t.trend, rsi: t.rsi })) } : mtf }),
    disclaimer: 'Rule-based technical read, not financial advice.',
  };
}
