/**
 * Confluence entry zones — the "where exactly do I enter?" engine.
 *
 * Gathers every level source we compute (S/R clusters, pivots, previous
 * day H/L, Fibonacci, volume profile POC/VAH/VAL/HVN, unfilled FVGs, order
 * blocks, EMAs, VWAP ±bands, equal highs/lows, round numbers), merges the
 * ones that sit within a fraction of ATR of each other, and scores each
 * zone by how many independent sources agree. A zone where 4–5 unrelated
 * methods line up is a far better limit-order location than any single line.
 *
 * buildZones() and planFromZones() are pure.
 */
import * as ta from './ta.js';
import { computeKeyLevels } from './analysis.js';
import { volumeProfile, fibonacci } from './profile.js';
import { fairValueGaps, orderBlocks, equalHighsLows } from './smc.js';

const W = {
  sr: 2, pivot: 1, prev_day: 1.5, fib_golden: 2, fib: 1, poc: 2, va_edge: 1.5, hvn: 1,
  fvg: 1.5, order_block: 2, ema200: 1.5, ema50: 1, ema20: 0.5, vwap: 1, vwap_band: 0.5,
  equal_hl: 1.5, round_number: 0.5,
};

/** Psychological round-number spacing: a 1/2/5 × 10^k step near 0.5–1% of price. */
export function roundNumberStep(price) {
  const target = price * 0.005;
  const mag = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5, 10]) if (m * mag >= target) return m * mag;
  return 10 * mag;
}

// Independent "families" — several hits from one method count once per zone.
const FAMILY = {
  sr: 'structure', pivot: 'pivot', prev_day: 'prev_period', fib: 'fibonacci', vp: 'volume_profile',
  fvg: 'fvg', ob: 'order_block', ema: 'moving_average', vwap: 'vwap', liq: 'liquidity', round: 'round_number',
};

/** Collect raw level candidates {price | low/high, source, weight}. */
export function collectLevels(bars) {
  const closes = bars.map(b => b.close);
  const close = closes.at(-1);
  const L = [];
  const add = (family, source, weight, price, extra = {}) => { if (price != null && Number.isFinite(price)) L.push({ family, source, weight, price, ...extra }); };
  const addZone = (family, source, weight, low, high, extra = {}) => { if (Number.isFinite(low) && Number.isFinite(high)) L.push({ family, source, weight, price: (low + high) / 2, low, high, ...extra }); };

  const kl = computeKeyLevels(bars, { max_levels: 10 });
  for (const z of [...kl.support, ...kl.resistance]) add(FAMILY.sr, `S/R ×${z.touches}`, W.sr * Math.min(2, 0.5 + z.touches * 0.5), z.price);
  for (const [k, v] of Object.entries(kl.pivots || {})) add(FAMILY.pivot, `Pivot ${k.toUpperCase()}`, W.pivot, v);
  if (kl.previous_period) {
    add(FAMILY.prev_day, kl.period_type === 'previous_day' ? 'Prev day high' : 'Prev bar high', W.prev_day, kl.previous_period.high);
    add(FAMILY.prev_day, kl.period_type === 'previous_day' ? 'Prev day low' : 'Prev bar low', W.prev_day, kl.previous_period.low);
  }

  const fib = fibonacci(bars);
  if (fib.found) {
    for (const r of fib.retracements) {
      if (r.ratio === 0.65) continue;
      add(FAMILY.fib, `Fib ${r.ratio}`, r.ratio === 0.618 ? W.fib_golden : W.fib, r.price);
    }
    addZone(FAMILY.fib, 'Golden pocket', W.fib_golden, fib.golden_pocket.low, fib.golden_pocket.high);
    for (const e of fib.extensions.slice(0, 3)) add(FAMILY.fib, `Fib ext ${e.ratio}`, W.fib, e.price);
  }

  try {
    const vp = volumeProfile(bars);
    add(FAMILY.vp, 'Volume POC', W.poc, vp.poc);
    add(FAMILY.vp, 'Value area high', W.va_edge, vp.vah);
    add(FAMILY.vp, 'Value area low', W.va_edge, vp.val);
    for (const h of vp.hvn) add(FAMILY.vp, 'High-volume node', W.hvn, h);
  } catch { /* no volume data — skip */ }

  for (const g of fairValueGaps(bars, { lookback: 150 })) addZone(FAMILY.fvg, `${g.type} FVG`, W.fvg, g.low, g.high, { bias: g.type });
  for (const o of orderBlocks(bars, { lookback: 150 })) addZone(FAMILY.ob, `${o.type} order block`, W.order_block, o.low, o.high, { bias: o.type });
  for (const e of equalHighsLows(bars)) add(FAMILY.liq, e.type === 'equal_highs' ? `Equal highs ×${e.touches}` : `Equal lows ×${e.touches}`, W.equal_hl, e.price);

  add(FAMILY.ema, 'EMA 20', W.ema20, ta.last(ta.ema(closes, 20)));
  add(FAMILY.ema, 'EMA 50', W.ema50, ta.last(ta.ema(closes, 50)));
  add(FAMILY.ema, 'EMA 200', W.ema200, ta.last(ta.ema(closes, 200)));
  const vb = ta.vwapBands(bars.slice(-Math.min(bars.length, 100)));
  add(FAMILY.vwap, 'VWAP (100 bars)', W.vwap, ta.last(vb.vwap));
  add(FAMILY.vwap, 'VWAP +2σ', W.vwap_band, ta.last(vb.upper_2));
  add(FAMILY.vwap, 'VWAP −2σ', W.vwap_band, ta.last(vb.lower_2));

  const step = roundNumberStep(close);
  for (let k = -2; k <= 2; k++) add(FAMILY.round, 'Round number', W.round_number, (Math.round(close / step) + k) * step);
  return L;
}

/** Merge levels within `merge_atr` × ATR into scored zones. */
export function buildZones(bars, { merge_atr = 0.35, max_distance_atr = 6 } = {}) {
  const close = bars.at(-1).close;
  const atr = ta.last(ta.atr(bars, 14));
  const levels = collectLevels(bars).filter(l => Math.abs(l.price - close) <= max_distance_atr * atr).sort((a, b) => a.price - b.price);
  const zones = [];
  for (const l of levels) {
    const z = zones.at(-1);
    const lo = l.low ?? l.price, hi = l.high ?? l.price;
    if (z && lo - z.high <= merge_atr * atr && hi - z.low <= merge_atr * atr * 3) {
      z.items.push(l); z.low = Math.min(z.low, lo); z.high = Math.max(z.high, hi);
    } else {
      zones.push({ items: [l], low: lo, high: hi });
    }
  }
  const r = (v) => ta.round(v, 8);
  return zones.map(z => {
    // Same-family sources count once (e.g. Fib 0.5 + Fib 0.618 in one zone ≠ two confirmations).
    const fam = new Map();
    for (const it of z.items) {
      fam.set(it.family, Math.max(fam.get(it.family) || 0, it.weight));
    }
    const score = [...fam.values()].reduce((a, b) => a + b, 0);
    const mid = (z.low + z.high) / 2;
    return {
      low: r(z.low), high: r(z.high), mid: r(mid),
      side: mid < close ? 'below' : 'above',
      distance_atr: ta.round((mid - close) / atr, 2),
      distance_pct: ta.round(((mid - close) / close) * 100, 3),
      score: ta.round(score, 2),
      confluences: fam.size,
      sources: [...new Set(z.items.map(i => i.source))],
      families: [...fam.keys()],
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Turn zones into a precise limit-order plan.
 * long: buy at the best zone BELOW price, stop beyond the zone (+buffer),
 * targets at the strongest zones ABOVE (mirror for short).
 */
export function planFromZones(bars, zones, { side = 'long', min_score = 3, max_entry_atr = 3, buffer_atr = 0.25, min_rr = 1.5 } = {}) {
  const close = bars.at(-1).close;
  const atr = ta.last(ta.atr(bars, 14));
  const long = side === 'long';
  const entryCands = zones.filter(z => (long ? z.side === 'below' : z.side === 'above') && Math.abs(z.distance_atr) <= max_entry_atr && z.score >= min_score);
  if (!entryCands.length) {
    return { side, action: 'no_setup', reason: `No ${long ? 'support' : 'resistance'} zone with score ≥ ${min_score} within ${max_entry_atr} ATR. Wait for price to come to a level.` };
  }
  // Prefer score, then proximity (a great zone 3 ATR away rarely fills).
  const best = [...entryCands].sort((a, b) => (b.score - Math.abs(b.distance_atr) * 0.5) - (a.score - Math.abs(a.distance_atr) * 0.5))[0];
  // Enter at the zone's near edge/middle: near edge fills more often, middle gives better price.
  const entry = long ? Math.min(close, best.high - (best.high - best.low) * 0.3) : Math.max(close, best.low + (best.high - best.low) * 0.3);
  const stop = long ? best.low - buffer_atr * atr : best.high + buffer_atr * atr;
  const risk = Math.abs(entry - stop);
  const targetZones = zones
    .filter(z => (long ? z.low > entry : z.high < entry) && z.score >= 2)
    .sort((a, b) => (long ? a.low - b.low : b.high - a.high));
  const targets = [];
  for (const z of targetZones) {
    const t = long ? z.low : z.high;           // take profit at the near edge of the opposing zone
    const rr = ((t - entry) * (long ? 1 : -1)) / risk;
    if (rr >= 1 && targets.length < 3) targets.push({ price: ta.round(t, 8), r_multiple: ta.round(rr, 2), zone_score: z.score, why: z.sources.slice(0, 3).join(' + ') });
  }
  if (!targets.length) targets.push({ price: ta.round(entry + (long ? 1 : -1) * 2 * risk, 8), r_multiple: 2, zone_score: null, why: '2R (no opposing zone far enough)' });
  const rr1 = targets[0].r_multiple;
  return {
    side,
    action: rr1 >= min_rr ? (long ? 'buy_limit' : 'sell_limit') : 'skip_poor_rr',
    entry: ta.round(entry, 8),
    entry_zone: { low: best.low, high: best.high, score: best.score, confluences: best.confluences, sources: best.sources },
    stop: ta.round(stop, 8),
    stop_reason: `Beyond the zone ${long ? 'low' : 'high'} + ${buffer_atr} ATR`,
    risk_per_unit: ta.round(risk, 8),
    targets,
    first_target_rr: rr1,
    trigger: long
      ? 'Best: wait for price to tag the zone, then a bullish reaction (hammer/engulfing, sweep of the zone low that closes back inside, or a lower-timeframe break of structure) before entering.'
      : 'Best: wait for price to tag the zone, then a bearish reaction (shooting star/engulfing, sweep of the zone high that closes back inside, or a lower-timeframe break of structure) before entering.',
    invalidation: `${long ? 'Close below' : 'Close above'} ${ta.round(stop, 8)}`,
    ...(rr1 < min_rr && { warning: `First target only ${rr1}R (< ${min_rr}R). Skip or wait for a better price.` }),
  };
}
