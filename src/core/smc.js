/**
 * Pure Smart-Money-Concepts detection: fair value gaps, order blocks,
 * liquidity sweeps and equal highs/lows (resting liquidity).
 * Bars are { time, open, high, low, close }, oldest first.
 */
import { atr as atrSeries, swingPoints, round } from './ta.js';

const p = (v) => round(v, 8);

/**
 * Fair value gaps (3-bar imbalances). Bullish: bar[i-2].high < bar[i].low.
 * Tracks how much of each gap later price filled; returns open (unfilled or
 * partially filled) gaps, newest first. min_atr filters out tiny gaps.
 */
export function fairValueGaps(bars, { lookback = 150, min_atr = 0.1, include_filled = false } = {}) {
  const a = atrSeries(bars, 14);
  const out = [];
  const start = Math.max(2, bars.length - lookback);
  for (let i = start; i < bars.length; i++) {
    const atrI = a[i] || a.findLast?.(v => v != null) || 0;
    const b0 = bars[i - 2], b2 = bars[i];
    let gap = null;
    if (b0.high < b2.low) gap = { type: 'bullish', low: b0.high, high: b2.low };
    else if (b0.low > b2.high) gap = { type: 'bearish', low: b2.high, high: b0.low };
    if (!gap || gap.high - gap.low < min_atr * atrI) continue;

    // Mitigation: how deep did later bars trade back into the gap?
    let deepest = gap.type === 'bullish' ? gap.high : gap.low;
    for (let j = i + 1; j < bars.length; j++) {
      if (gap.type === 'bullish') deepest = Math.min(deepest, bars[j].low);
      else deepest = Math.max(deepest, bars[j].high);
    }
    const size = gap.high - gap.low;
    const filled = gap.type === 'bullish'
      ? Math.min(1, Math.max(0, (gap.high - deepest) / size))
      : Math.min(1, Math.max(0, (deepest - gap.low) / size));
    if (filled >= 1 && !include_filled) continue;
    out.push({
      type: gap.type, low: p(gap.low), high: p(gap.high), mid: p((gap.low + gap.high) / 2),
      size_atr: round(size / (atrI || 1), 2), filled_pct: round(filled * 100, 0),
      time: bars[i - 1].time, bars_ago: bars.length - 1 - i,
    });
  }
  return out.reverse();
}

/**
 * Order blocks: the last opposite-colour candle before a displacement move
 * (≥ `displacement_atr` × ATR within 3 bars) that breaks the prior swing.
 * An OB is invalidated once price CLOSES through its far side.
 */
export function orderBlocks(bars, { lookback = 150, displacement_atr = 1.5, include_mitigated = false } = {}) {
  const a = atrSeries(bars, 14);
  const { highs, lows } = swingPoints(bars, 3, 3);
  const out = [];
  const start = Math.max(4, bars.length - lookback);
  for (let i = start; i < bars.length - 1; i++) {
    const atrI = a[i];
    if (!atrI) continue;
    const end = Math.min(bars.length - 1, i + 3);
    const moveUp = Math.max(...bars.slice(i + 1, end + 1).map(b => b.high)) - bars[i].close;
    const moveDn = bars[i].close - Math.min(...bars.slice(i + 1, end + 1).map(b => b.low));
    const bullCandidate = bars[i].close < bars[i].open && moveUp >= displacement_atr * atrI;
    const bearCandidate = bars[i].close > bars[i].open && moveDn >= displacement_atr * atrI;
    if (!bullCandidate && !bearCandidate) continue;
    const type = bullCandidate ? 'bullish' : 'bearish';
    // Must break structure: the impulse clears the most recent swing before it.
    const prevSwing = (type === 'bullish' ? highs : lows).filter(s => s.index < i).at(-1);
    const impulseExtreme = type === 'bullish' ? Math.max(...bars.slice(i + 1, end + 1).map(b => b.high)) : Math.min(...bars.slice(i + 1, end + 1).map(b => b.low));
    const bos = prevSwing ? (type === 'bullish' ? impulseExtreme > prevSwing.price : impulseExtreme < prevSwing.price) : false;
    if (!bos) continue;
    const zone = { low: bars[i].low, high: bars[i].high };
    let mitigated = false, tested = false;
    for (let j = end + 1; j < bars.length; j++) {
      if (type === 'bullish') { if (bars[j].low <= zone.high) tested = true; if (bars[j].close < zone.low) { mitigated = true; break; } }
      else { if (bars[j].high >= zone.low) tested = true; if (bars[j].close > zone.high) { mitigated = true; break; } }
    }
    if (mitigated && !include_mitigated) continue;
    out.push({
      type, low: p(zone.low), high: p(zone.high), mid: p((zone.low + zone.high) / 2),
      displacement_atr: round((type === 'bullish' ? moveUp : moveDn) / atrI, 2),
      tested, mitigated, time: bars[i].time, bars_ago: bars.length - 1 - i,
    });
  }
  // Collapse consecutive candidates from the same impulse: keep the newest per overlapping zone.
  const dedup = [];
  for (const ob of out.reverse()) if (!dedup.some(d => d.type === ob.type && ob.low <= d.high && ob.high >= d.low)) dedup.push(ob);
  return dedup;
}

/**
 * Liquidity sweeps (stop hunts): a bar wicks beyond a prior swing high/low
 * but closes back inside. Bearish sweep above highs, bullish sweep below lows.
 */
export function liquiditySweeps(bars, { lookback = 30, left = 3, right = 3 } = {}) {
  const { highs, lows } = swingPoints(bars, left, right);
  const out = [];
  for (let i = Math.max(1, bars.length - lookback); i < bars.length; i++) {
    const b = bars[i];
    const h = highs.filter(s => s.index < i - right).at(-1);
    const l = lows.filter(s => s.index < i - right).at(-1);
    if (h && b.high > h.price && b.close < h.price) out.push({ type: 'bearish', swept_level: p(h.price), wick_high: p(b.high), close: p(b.close), time: b.time, bars_ago: bars.length - 1 - i, meaning: 'Buy-side liquidity taken, closed back below — potential reversal down' });
    if (l && b.low < l.price && b.close > l.price) out.push({ type: 'bullish', swept_level: p(l.price), wick_low: p(b.low), close: p(b.close), time: b.time, bars_ago: bars.length - 1 - i, meaning: 'Sell-side liquidity taken, closed back above — potential reversal up' });
  }
  return out.reverse();
}

/** Equal highs / lows within `tolerance_atr` × ATR — resting stop liquidity that price tends to seek. */
export function equalHighsLows(bars, { tolerance_atr = 0.15, left = 3, right = 3 } = {}) {
  const { highs, lows } = swingPoints(bars, left, right);
  const a = atrSeries(bars, 14).findLast?.(v => v != null) || 0;
  const tol = a * tolerance_atr;
  const close = bars[bars.length - 1].close;
  const groups = (pts, kind) => {
    const res = [];
    for (let i = 0; i < pts.length; i++) {
      const grp = pts.filter(q => Math.abs(q.price - pts[i].price) <= tol);
      if (grp.length < 2 || grp[0] !== pts[i]) continue;
      const lvl = grp.reduce((s, q) => s + q.price, 0) / grp.length;
      const taken = kind === 'equal_highs' ? bars.slice(grp.at(-1).index + 1).some(b => b.high > lvl + tol) : bars.slice(grp.at(-1).index + 1).some(b => b.low < lvl - tol);
      if (!taken) res.push({ type: kind, price: p(lvl), touches: grp.length, last_time: grp.at(-1).time, distance_pct: round(((lvl - close) / close) * 100, 3) });
    }
    return res;
  };
  return [...groups(highs, 'equal_highs'), ...groups(lows, 'equal_lows')];
}

/** Everything at once, filtered to what's still relevant near price. */
export function smartMoney(bars, opts = {}) {
  const close = bars[bars.length - 1].close;
  const near = (z) => Math.abs((z.mid ?? z.price) - close) / close <= (opts.max_distance_pct ?? 10) / 100;
  const fvg = fairValueGaps(bars, opts).filter(near).slice(0, 8);
  const ob = orderBlocks(bars, opts).filter(near).slice(0, 6);
  const sweeps = liquiditySweeps(bars, opts).slice(0, 5);
  const eq = equalHighsLows(bars, opts).filter(near);
  const below = (arr) => arr.filter(z => z.type === 'bullish' && z.high <= close * 1.002);
  const above = (arr) => arr.filter(z => z.type === 'bearish' && z.low >= close * 0.998);
  return {
    close: p(close),
    fair_value_gaps: fvg,
    order_blocks: ob,
    liquidity_sweeps: sweeps,
    equal_highs_lows: eq,
    summary: {
      bullish_zones_below: below([...fvg, ...ob]).length,
      bearish_zones_above: above([...fvg, ...ob]).length,
      recent_sweep: sweeps[0] && sweeps[0].bars_ago <= 5 ? `${sweeps[0].type} sweep of ${sweeps[0].swept_level} ${sweeps[0].bars_ago} bars ago` : null,
      liquidity_targets: eq.map(e => `${e.type.replace('_', ' ')} at ${e.price} (${e.touches}×)`),
    },
  };
}
