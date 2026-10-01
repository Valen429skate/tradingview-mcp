/**
 * Pure candlestick-pattern and market-structure detection.
 * Bars are { time, open, high, low, close }, oldest first.
 */
import { atr as atrSeries, ema, swingPoints, round } from './ta.js';

const body = (b) => Math.abs(b.close - b.open);
const range = (b) => b.high - b.low;
const upperWick = (b) => b.high - Math.max(b.open, b.close);
const lowerWick = (b) => Math.min(b.open, b.close) - b.low;
const bull = (b) => b.close > b.open;
const bear = (b) => b.close < b.open;

/**
 * Each detector gets (bars, i, ctx) and returns a bias ('bullish' | 'bearish' |
 * 'neutral') when the pattern completes on bar i, else null. ctx.trend is the
 * EMA20 slope sign before the pattern, so reversal patterns only fire against
 * the prior move.
 */
const DETECTORS = {
  doji: (b, i) => (range(b[i]) > 0 && body(b[i]) <= range(b[i]) * 0.1 ? 'neutral' : null),

  hammer: (b, i, ctx) => {
    const x = b[i];
    if (ctx.trend >= 0 || range(x) === 0) return null;
    return lowerWick(x) >= 2 * body(x) && upperWick(x) <= body(x) * 0.5 + range(x) * 0.05 && body(x) > 0 ? 'bullish' : null;
  },

  shooting_star: (b, i, ctx) => {
    const x = b[i];
    if (ctx.trend <= 0 || range(x) === 0) return null;
    return upperWick(x) >= 2 * body(x) && lowerWick(x) <= body(x) * 0.5 + range(x) * 0.05 && body(x) > 0 ? 'bearish' : null;
  },

  bullish_engulfing: (b, i, ctx) => {
    if (i < 1 || ctx.trend > 0) return null;
    const p = b[i - 1], x = b[i];
    return bear(p) && bull(x) && x.close >= p.open && x.open <= p.close && body(x) > body(p) ? 'bullish' : null;
  },

  bearish_engulfing: (b, i, ctx) => {
    if (i < 1 || ctx.trend < 0) return null;
    const p = b[i - 1], x = b[i];
    return bull(p) && bear(x) && x.open >= p.close && x.close <= p.open && body(x) > body(p) ? 'bearish' : null;
  },

  inside_bar: (b, i) => (i >= 1 && b[i].high < b[i - 1].high && b[i].low > b[i - 1].low ? 'neutral' : null),

  outside_bar: (b, i) => (i >= 1 && b[i].high > b[i - 1].high && b[i].low < b[i - 1].low ? (bull(b[i]) ? 'bullish' : 'bearish') : null),

  morning_star: (b, i, ctx) => {
    if (i < 2 || ctx.trend > 0) return null;
    const [a, m, c] = [b[i - 2], b[i - 1], b[i]];
    return bear(a) && body(a) > range(a) * 0.5 && body(m) < body(a) * 0.4 && bull(c) && c.close > (a.open + a.close) / 2 ? 'bullish' : null;
  },

  evening_star: (b, i, ctx) => {
    if (i < 2 || ctx.trend < 0) return null;
    const [a, m, c] = [b[i - 2], b[i - 1], b[i]];
    return bull(a) && body(a) > range(a) * 0.5 && body(m) < body(a) * 0.4 && bear(c) && c.close < (a.open + a.close) / 2 ? 'bearish' : null;
  },

  three_white_soldiers: (b, i) => {
    if (i < 2) return null;
    const s = [b[i - 2], b[i - 1], b[i]];
    return s.every(x => bull(x) && body(x) > range(x) * 0.6) && s[1].close > s[0].close && s[2].close > s[1].close ? 'bullish' : null;
  },

  three_black_crows: (b, i) => {
    if (i < 2) return null;
    const s = [b[i - 2], b[i - 1], b[i]];
    return s.every(x => bear(x) && body(x) > range(x) * 0.6) && s[1].close < s[0].close && s[2].close < s[1].close ? 'bearish' : null;
  },
};

export const PATTERN_NAMES = Object.keys(DETECTORS);

export function detectCandles(bars, { lookback = 20, patterns } = {}) {
  const names = patterns && patterns.length ? patterns : PATTERN_NAMES;
  for (const n of names) if (!DETECTORS[n]) throw new Error(`Unknown pattern "${n}". Available: ${PATTERN_NAMES.join(', ')}`);
  const closes = bars.map(b => b.close);
  const e = ema(closes, 20);
  const out = [];
  const start = Math.max(0, bars.length - lookback);
  for (let i = start; i < bars.length; i++) {
    const prevE = e[i - 1], prevE2 = e[i - 4];
    const trend = prevE != null && prevE2 != null ? Math.sign(prevE - prevE2) : 0;
    for (const n of names) {
      const bias = DETECTORS[n](bars, i, { trend });
      if (bias) out.push({ pattern: n, bias, time: bars[i].time, bars_ago: bars.length - 1 - i, close: bars[i].close });
    }
  }
  return out;
}

/**
 * Market structure from swing points: HH/HL (uptrend), LH/LL (downtrend) and
 * the most recent break of structure (close beyond the last swing high/low).
 */
export function marketStructure(bars, { left = 3, right = 3 } = {}) {
  const { highs, lows } = swingPoints(bars, left, right);
  const label = (pts, up, down) => pts.slice(1).map((p, k) => ({ ...p, label: p.price > pts[k].price ? up : down }));
  const hs = label(highs, 'HH', 'LH');
  const ls = label(lows, 'HL', 'LL');
  const lastH = hs.slice(-2).map(x => x.label);
  const lastL = ls.slice(-2).map(x => x.label);
  let structure = 'ranging';
  if (lastH.length && lastL.length) {
    if (lastH.at(-1) === 'HH' && lastL.at(-1) === 'HL') structure = 'uptrend';
    else if (lastH.at(-1) === 'LH' && lastL.at(-1) === 'LL') structure = 'downtrend';
  }
  const close = bars.at(-1).close;
  const lastSwingHigh = highs.at(-1);
  const lastSwingLow = lows.at(-1);
  let bos = null;
  if (lastSwingHigh && close > lastSwingHigh.price) bos = { direction: 'bullish', level: lastSwingHigh.price, swing_time: lastSwingHigh.time };
  else if (lastSwingLow && close < lastSwingLow.price) bos = { direction: 'bearish', level: lastSwingLow.price, swing_time: lastSwingLow.time };
  const a = atrSeries(bars, 14).at(-1);
  return {
    structure,
    recent_highs: hs.slice(-3).map(p => ({ price: round(p.price), label: p.label, time: p.time })),
    recent_lows: ls.slice(-3).map(p => ({ price: round(p.price), label: p.label, time: p.time })),
    last_swing_high: lastSwingHigh ? round(lastSwingHigh.price) : null,
    last_swing_low: lastSwingLow ? round(lastSwingLow.price) : null,
    break_of_structure: bos,
    atr: round(a),
  };
}
