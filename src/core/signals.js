/**
 * Pure divergence detection and market-regime classification.
 */
import * as ta from './ta.js';

const p = (v) => ta.round(v, 8);

/**
 * Regular & hidden divergences between price swings and an oscillator.
 *   regular bullish: price lower low,  osc higher low  → reversal up
 *   hidden  bullish: price higher low, osc lower low   → uptrend continuation
 *   regular bearish: price higher high, osc lower high → reversal down
 *   hidden  bearish: price lower high, osc higher high → downtrend continuation
 * Only pairs of consecutive swings within `max_gap` bars are compared;
 * `recent` limits results to divergences whose second swing is that fresh.
 */
export function divergences(bars, { oscillator = 'rsi', left = 3, right = 3, max_gap = 60, recent = 30 } = {}) {
  const closes = bars.map(b => b.close);
  let osc;
  if (oscillator === 'rsi') osc = ta.rsi(closes, 14);
  else if (oscillator === 'macd') osc = ta.macd(closes).histogram;
  else if (oscillator === 'obv') osc = ta.obv(bars);
  else if (oscillator === 'stoch') osc = ta.stochastic(bars).k;
  else throw new Error('oscillator must be rsi, macd, obv or stoch');
  const { highs, lows } = ta.swingPoints(bars, left, right);
  const out = [];
  const cmp = (pts, isLow) => {
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      if (b.index - a.index > max_gap || osc[a.index] == null || osc[b.index] == null) continue;
      if (bars.length - 1 - b.index > recent) continue;
      const pa = a.price, pb = b.price, oa = osc[a.index], ob = osc[b.index];
      let type = null;
      if (isLow && pb < pa && ob > oa) type = 'regular_bullish';
      else if (isLow && pb > pa && ob < oa) type = 'hidden_bullish';
      else if (!isLow && pb > pa && ob < oa) type = 'regular_bearish';
      else if (!isLow && pb < pa && ob > oa) type = 'hidden_bearish';
      if (!type) continue;
      out.push({
        type, bias: type.endsWith('bullish') ? 'bullish' : 'bearish', oscillator,
        price_from: p(pa), price_to: p(pb), osc_from: ta.round(oa, 3), osc_to: ta.round(ob, 3),
        from_time: a.time, to_time: b.time, bars_ago: bars.length - 1 - b.index,
        // Confirmed only `right` bars after the pivot — this is the honest signal time.
        confirmed_bars_ago: Math.max(0, bars.length - 1 - (b.index + right)),
      });
    }
  };
  cmp(lows, true);
  cmp(highs, false);
  return out.sort((x, y) => x.bars_ago - y.bars_ago);
}

/**
 * Market regime from ADX, Choppiness, efficiency ratio and Bollinger width
 * percentile. Tells you WHICH playbook fits: trend-following, mean
 * reversion, or breakout-from-squeeze.
 */
export function regime(bars) {
  if (bars.length < 60) throw new Error('Need at least 60 bars for regime detection');
  const closes = bars.map(b => b.close);
  const d = ta.adx(bars, 14);
  const adxV = ta.last(d.adx), pdi = ta.last(d.plusDI), mdi = ta.last(d.minusDI);
  const chop = ta.last(ta.choppiness(bars, 14));
  const er = ta.last(ta.efficiencyRatio(closes, 20));
  const width = ta.bbWidth(closes, 20, 2);
  const widthRank = ta.percentRank(width, 120);
  const st = ta.supertrend(bars, 10, 3);
  const atrPct = (ta.last(ta.atr(bars, 14)) / closes.at(-1)) * 100;
  const atrRank = ta.percentRank(ta.atr(bars, 14).map((v, i) => (v == null ? null : (v / closes[i]) * 100)), 120);

  let state, playbook;
  const dir = pdi > mdi ? 'up' : 'down';
  if (widthRank != null && widthRank <= 15 && (adxV ?? 0) < 25) {
    state = 'squeeze';
    playbook = 'Volatility compressed — expect expansion. Trade the breakout of the range (Donchian/Bollinger) with a stop inside the range; avoid fading.';
  } else if ((adxV ?? 0) >= 25 && (chop ?? 100) < 50) {
    state = `trending_${dir}`;
    playbook = `Trending ${dir} — trade WITH the trend: buy pullbacks to EMA20/50, VWAP, fib 0.5–0.618 or fresh ${dir === 'up' ? 'bullish' : 'bearish'} FVG/order blocks; trail stops (Supertrend / ATR). Avoid counter-trend fades.`;
  } else if ((adxV ?? 0) < 20 || (chop ?? 0) > 61.8) {
    state = 'ranging';
    playbook = 'Ranging — mean reversion: fade value-area extremes (VAH/VAL), range highs/lows, Bollinger bands, RSI/Stoch extremes, liquidity sweeps; target POC / midpoint. Avoid breakout chasing.';
  } else {
    state = 'transition';
    playbook = 'Mixed signals — reduce size, wait for ADX > 25 (trend) or a clear range to form.';
  }
  if (atrRank != null && atrRank >= 90) playbook += ' Volatility is extreme: widen stops and cut size.';

  return {
    state,
    trend_direction: dir,
    trend_strength: (adxV ?? 0) >= 40 ? 'very_strong' : (adxV ?? 0) >= 25 ? 'strong' : (adxV ?? 0) >= 20 ? 'emerging' : 'weak',
    adx: ta.round(adxV, 2), plus_di: ta.round(pdi, 2), minus_di: ta.round(mdi, 2),
    choppiness: ta.round(chop, 2),
    efficiency_ratio: ta.round(er, 3),
    bb_width_percentile: ta.round(widthRank, 1),
    atr_pct: ta.round(atrPct, 3),
    atr_percentile: ta.round(atrRank, 1),
    supertrend: { direction: ta.last(st.dir) === 1 ? 'up' : 'down', level: p(ta.last(st.line)) },
    playbook,
  };
}
