/**
 * Pure technical-analysis math. No CDP, no I/O — every function takes plain
 * arrays/bars and returns plain values, so it is fully unit-testable.
 *
 * Bars are { time, open, high, low, close, volume } objects, oldest first.
 * Series functions return arrays aligned to the input (null while warming up).
 */

const round = (v, dp = 8) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
export { round };

export function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI (same smoothing TradingView's ta.rsi uses). */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  const calc = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = calc();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = calc();
  }
  return out;
}

export function trueRange(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

/** Wilder's ATR (RMA of true range). */
export function atr(bars, period = 14) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  const means = sma(values, period);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - means[i]) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const sd = stdev(values, period);
  return {
    middle: mid,
    upper: mid.map((m, i) => (m == null ? null : m + mult * sd[i])),
    lower: mid.map((m, i) => (m == null ? null : m - mult * sd[i])),
  };
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
  const firstIdx = line.findIndex(v => v != null);
  const sig = new Array(values.length).fill(null);
  if (firstIdx >= 0) {
    const sigVals = ema(line.slice(firstIdx), signal);
    sigVals.forEach((v, i) => { sig[firstIdx + i] = v; });
  }
  return { macd: line, signal: sig, histogram: line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i])) };
}

/** Volume-weighted average price over the given bars (anchored at bars[0]). */
export function vwap(bars) {
  let pv = 0, vol = 0;
  return bars.map(b => {
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * (b.volume || 0); vol += b.volume || 0;
    return vol > 0 ? pv / vol : null;
  });
}

/** Log-return Pearson correlation of two equal-length close series. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ra = [], rb = [];
  const offA = a.length - n, offB = b.length - n;
  for (let i = 1; i < n; i++) {
    ra.push(Math.log(a[offA + i] / a[offA + i - 1]));
    rb.push(Math.log(b[offB + i] / b[offB + i - 1]));
  }
  const ma = ra.reduce((x, y) => x + y, 0) / ra.length;
  const mb = rb.reduce((x, y) => x + y, 0) / rb.length;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

/** Classic floor-trader pivots from a single completed period's H/L/C. */
export function pivots({ high, low, close }) {
  const p = (high + low + close) / 3;
  return {
    r3: high + 2 * (p - low), r2: p + (high - low), r1: 2 * p - low,
    p,
    s1: 2 * p - high, s2: p - (high - low), s3: low - 2 * (high - p),
  };
}

/**
 * Fractal swing points: a bar whose high (low) is the extreme of the `left`
 * bars before and `right` bars after it.
 */
export function swingPoints(bars, left = 3, right = 3) {
  const highs = [], lows = [];
  for (let i = left; i < bars.length - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      // Ties: left side must be strictly lower/higher, right side may equal —
      // so a flat top/bottom yields exactly one pivot (its first bar).
      if (j < i ? bars[j].high >= bars[i].high : bars[j].high > bars[i].high) isH = false;
      if (j < i ? bars[j].low <= bars[i].low : bars[j].low < bars[i].low) isL = false;
    }
    if (isH) highs.push({ time: bars[i].time, price: bars[i].high, index: i });
    if (isL) lows.push({ time: bars[i].time, price: bars[i].low, index: i });
  }
  return { highs, lows };
}

/**
 * Cluster swing prices that sit within `tolerance` (absolute price) of each
 * other into S/R zones. More touches = stronger level.
 */
export function clusterLevels(points, tolerance) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && p.price - c.max <= tolerance) {
      c.prices.push(p.price); c.max = p.price; c.last_time = Math.max(c.last_time, p.time);
    } else {
      clusters.push({ prices: [p.price], min: p.price, max: p.price, last_time: p.time });
    }
  }
  return clusters.map(c => ({
    price: c.prices.reduce((a, b) => a + b, 0) / c.prices.length,
    zone_low: c.min, zone_high: c.max, touches: c.prices.length, last_touch: c.last_time,
  }));
}

/** Group intraday bars into UTC calendar days → daily OHLC bars. */
export function groupByDay(bars) {
  const days = new Map();
  for (const b of bars) {
    const key = new Date(b.time * 1000).toISOString().slice(0, 10);
    const d = days.get(key);
    if (!d) days.set(key, { date: key, time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
    else { d.high = Math.max(d.high, b.high); d.low = Math.min(d.low, b.low); d.close = b.close; d.volume += b.volume || 0; }
  }
  return [...days.values()];
}

/**
 * Snapshot of common metrics on the latest bar. This is what screeners and
 * multi-timeframe summaries evaluate conditions against.
 */
export function snapshot(bars) {
  const closes = bars.map(b => b.close);
  const c = closes[closes.length - 1];
  const bb = bollinger(closes, 20, 2);
  const m = macd(closes);
  const a = last(atr(bars, 14));
  const e20 = last(ema(closes, 20)), e50 = last(ema(closes, 50)), e200 = last(ema(closes, 200));
  const vols = bars.map(b => b.volume || 0);
  const avgVol = last(sma(vols, 20));
  const lookback = bars.slice(-20);
  const snap = {
    close: c,
    open: bars[bars.length - 1].open,
    high: bars[bars.length - 1].high,
    low: bars[bars.length - 1].low,
    volume: vols[vols.length - 1],
    change_pct: closes.length > 1 ? ((c - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : null,
    rsi: last(rsi(closes, 14)),
    atr: a,
    atr_pct: a != null ? (a / c) * 100 : null,
    sma20: last(sma(closes, 20)), sma50: last(sma(closes, 50)), sma200: last(sma(closes, 200)),
    ema20: e20, ema50: e50, ema200: e200,
    bb_upper: last(bb.upper), bb_middle: last(bb.middle), bb_lower: last(bb.lower),
    macd: last(m.macd), macd_signal: last(m.signal), macd_hist: last(m.histogram),
    avg_volume: avgVol,
    rel_volume: avgVol ? vols[vols.length - 1] / avgVol : null,
    high_20: Math.max(...lookback.map(b => b.high)),
    low_20: Math.min(...lookback.map(b => b.low)),
  };
  snap.trend = trendLabel(snap);
  for (const k of Object.keys(snap)) if (typeof snap[k] === 'number') snap[k] = round(snap[k], 6);
  return snap;
}

/** Simple, explainable trend classification from EMA stack + RSI. */
export function trendLabel({ close, ema20, ema50, ema200, rsi: r }) {
  if (ema20 == null || ema50 == null) return 'insufficient_data';
  let score = 0;
  if (close > ema20) score++; else score--;
  if (ema20 > ema50) score++; else score--;
  if (ema200 != null) { if (close > ema200) score++; else score--; }
  if (r != null) { if (r > 55) score++; else if (r < 45) score--; }
  if (score >= 3) return 'strong_up';
  if (score >= 1) return 'up';
  if (score <= -3) return 'strong_down';
  if (score <= -1) return 'down';
  return 'neutral';
}

// ── Screener condition parsing ─────────────────────────────────────────────
// Grammar:  cond ( ("and"|"&&") cond )*      cond := operand op operand
// operand := metric name from snapshot() | number.   op := > >= < <= == !=
// No eval — the expression is tokenized and checked against a whitelist.

const OPS = {
  '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  '<': (a, b) => a < b, '<=': (a, b) => a <= b,
  '==': (a, b) => a === b, '!=': (a, b) => a !== b,
};

export function parseConditions(expr) {
  if (!expr || typeof expr !== 'string') throw new Error('condition must be a non-empty string, e.g. "rsi < 30 and close > ema200"');
  return expr.split(/\s+(?:and|AND|&&)\s+/).map(part => {
    const m = part.trim().match(/^([A-Za-z_][\w]*|-?\d+(?:\.\d+)?)\s*(>=|<=|==|!=|>|<)\s*([A-Za-z_][\w]*|-?\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`Cannot parse condition "${part.trim()}". Use "<metric> <op> <metric|number>", e.g. "rsi < 30".`);
    return { left: m[1], op: m[2], right: m[3], text: part.trim() };
  });
}

export function evaluateConditions(conds, snap) {
  const val = (tok) => {
    if (/^-?\d/.test(tok)) return Number(tok);
    if (!(tok in snap)) throw new Error(`Unknown metric "${tok}". Available: ${Object.keys(snap).filter(k => typeof snap[k] === 'number').join(', ')}`);
    return snap[tok];
  };
  const details = conds.map(c => {
    const l = val(c.left), r = val(c.right);
    const pass = l != null && r != null && OPS[c.op](l, r);
    return { condition: c.text, left: round(l, 6), right: round(r, 6), pass };
  });
  return { pass: details.every(d => d.pass), details };
}
