/**
 * Pure Volume Profile and auto-Fibonacci.
 * Bars are { time, open, high, low, close, volume }, oldest first.
 */
import { swingPoints, atr, last, round } from './ta.js';

/**
 * Volume-at-price histogram. Each bar's volume is spread across the price
 * rows its high–low range overlaps (proportional to overlap), which is the
 * standard approximation when tick data isn't available.
 *
 * Returns POC (point of control), the value area (default 70% of volume),
 * and high/low volume nodes (HVN = acceptance / magnets, LVN = rejection /
 * fast-move areas).
 */
export function volumeProfile(bars, { rows = 30, value_area = 0.7 } = {}) {
  if (!bars.length) throw new Error('No bars for volume profile');
  const lo = Math.min(...bars.map(b => b.low)), hi = Math.max(...bars.map(b => b.high));
  if (hi === lo) throw new Error('Flat price range — no profile');
  const step = (hi - lo) / rows;
  const vol = new Array(rows).fill(0);
  let total = 0;
  for (const b of bars) {
    const v = b.volume || 0;
    if (!v) continue;
    total += v;
    const span = b.high - b.low;
    const r0 = Math.min(rows - 1, Math.floor((b.low - lo) / step));
    const r1 = Math.min(rows - 1, Math.floor((b.high - lo) / step));
    if (span === 0 || r0 === r1) { vol[r0] += v; continue; }
    for (let r = r0; r <= r1; r++) {
      const top = Math.min(b.high, lo + (r + 1) * step), bot = Math.max(b.low, lo + r * step);
      vol[r] += (v * Math.max(0, top - bot)) / span;
    }
  }
  if (!total) throw new Error('Bars have no volume — volume profile needs volume data');
  const mid = (r) => lo + (r + 0.5) * step;

  const poc = vol.indexOf(Math.max(...vol));
  // Value area: grow from POC, adding whichever neighbour has more volume.
  let a = poc, b = poc, inVA = vol[poc];
  while (inVA < total * value_area && (a > 0 || b < rows - 1)) {
    const up = b < rows - 1 ? vol[b + 1] : -1, dn = a > 0 ? vol[a - 1] : -1;
    if (up >= dn) inVA += vol[++b]; else inVA += vol[--a];
  }

  const avg = total / rows;
  const hvn = [], lvn = [];
  for (let r = 1; r < rows - 1; r++) {
    if (vol[r] > vol[r - 1] && vol[r] >= vol[r + 1] && vol[r] > avg * 1.2 && r !== poc) hvn.push(r);
    if (vol[r] < vol[r - 1] && vol[r] <= vol[r + 1] && vol[r] < avg * 0.6) lvn.push(r);
  }
  const close = bars[bars.length - 1].close;
  const p = (v) => round(v, 8);
  let position = 'inside_value';
  if (close > lo + (b + 1) * step) position = 'above_value';
  else if (close < lo + a * step) position = 'below_value';

  return {
    poc: p(mid(poc)),
    vah: p(lo + (b + 1) * step),
    val: p(lo + a * step),
    value_area_pct: round((inVA / total) * 100, 1),
    hvn: hvn.map(r => p(mid(r))),
    lvn: lvn.map(r => p(mid(r))),
    position,
    range: { low: p(lo), high: p(hi), row_size: p(step) },
    rows: vol.map((v, r) => ({ price: p(mid(r)), volume_pct: round((v / total) * 100, 2) })),
  };
}

const RETRACE = [0.236, 0.382, 0.5, 0.618, 0.65, 0.705, 0.786];
const EXTEND = [1.272, 1.414, 1.618, 2, 2.618];

/**
 * Auto-Fibonacci on the most recent significant leg (swing low → swing high
 * for an up-leg, or high → low for a down-leg). Retracements are pullback
 * entry candidates; extensions are profit targets in the leg's direction.
 * `min_atr` filters out small legs (default: leg must be ≥ 3 ATR).
 */
export function fibonacci(bars, { left = 5, right = 5, min_atr = 3 } = {}) {
  const { highs, lows } = swingPoints(bars, left, right);
  const a = last(atr(bars, 14)) || 0;
  const close = bars[bars.length - 1].close;
  // Walk back to the latest swing pair forming a leg of meaningful size.
  const pts = [...highs.map(h => ({ ...h, kind: 'high' })), ...lows.map(l => ({ ...l, kind: 'low' }))].sort((x, y) => x.index - y.index);
  let leg = null;
  for (let k = pts.length - 1; k > 0 && !leg; k--) {
    const end = pts[k];
    for (let j = k - 1; j >= 0; j--) {
      const start = pts[j];
      if (start.kind === end.kind) continue;
      if (Math.abs(end.price - start.price) >= min_atr * a) { leg = { start, end }; break; }
    }
  }
  if (!leg) return { found: false, note: 'No swing leg large enough (try a lower min_atr or more bars).' };

  // Extend the leg end to the extreme reached since (an unfinished leg keeps running).
  const up = leg.end.kind === 'high';
  const after = bars.slice(leg.end.index);
  const extreme = up ? Math.max(...after.map(b => b.high)) : Math.min(...after.map(b => b.low));
  const hi = up ? extreme : leg.start.price, lo = up ? leg.start.price : extreme;
  const range = hi - lo;
  const p = (v) => round(v, 8);

  const retracements = RETRACE.map(r => ({ ratio: r, price: p(up ? hi - range * r : lo + range * r) }));
  const extensions = EXTEND.map(r => ({ ratio: r, price: p(up ? lo + range * r : hi - range * r) }));
  const gp = up ? [hi - range * 0.65, hi - range * 0.618] : [lo + range * 0.618, lo + range * 0.65];
  const depth = up ? (hi - close) / range : (close - lo) / range;
  return {
    found: true,
    direction: up ? 'up' : 'down',
    swing_start: { price: p(up ? lo : hi), time: leg.start.time },
    swing_end: { price: p(up ? hi : lo), time: leg.end.time },
    retracements,
    golden_pocket: { low: p(Math.min(...gp)), high: p(Math.max(...gp)) },
    extensions,
    current_retracement: round(depth, 3),
    note: up
      ? 'Up-leg: retracements are long pullback zones (0.5–0.786, golden pocket 0.618–0.65); extensions are upside targets.'
      : 'Down-leg: retracements are short pullback zones; extensions are downside targets.',
  };
}
