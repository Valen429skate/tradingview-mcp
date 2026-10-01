/**
 * Core analysis logic — computes indicators, key levels, multi-timeframe
 * summaries, correlations and screener results from chart bars.
 *
 * The heavy lifting is the pure math in ta.js; this module only fetches bars
 * from the chart (and switches symbol/timeframe when asked, always restoring
 * the original chart state afterwards).
 */
import * as ta from './ta.js';
import { getOhlcv as _getOhlcv } from './data.js';
import { getState as _getState, setSymbol as _setSymbol, setTimeframe as _setTimeframe } from './chart.js';
import { get as _getWatchlist } from './watchlist.js';

const MAX_BARS = 500;
const MAX_SCAN_SYMBOLS = 50;
const MAX_MTF = 6;

function _resolve(deps) {
  return {
    getOhlcv: deps?.getOhlcv || _getOhlcv,
    getState: deps?.getState || _getState,
    setSymbol: deps?.setSymbol || _setSymbol,
    setTimeframe: deps?.setTimeframe || _setTimeframe,
    getWatchlist: deps?.getWatchlist || _getWatchlist,
    sleep: deps?.sleep || (ms => new Promise(r => setTimeout(r, ms))),
  };
}

async function fetchBars(d, count) {
  const res = await d.getOhlcv({ count: Math.min(count || MAX_BARS, MAX_BARS) });
  if (!res?.bars?.length) throw new Error('No bars returned from chart');
  return res.bars;
}

// Serializes tools that temporarily switch the chart, so two parallel calls
// can't leave the chart on the wrong symbol/timeframe.
let _chartLock = Promise.resolve();
function withChartLock(fn) {
  const run = _chartLock.then(fn, fn);
  _chartLock = run.catch(() => {});
  return run;
}

// ── data_compute ───────────────────────────────────────────────────────────

const INDICATORS = {
  sma: (bars, p = 20) => ta.sma(bars.map(b => b.close), p),
  ema: (bars, p = 20) => ta.ema(bars.map(b => b.close), p),
  rsi: (bars, p = 14) => ta.rsi(bars.map(b => b.close), p),
  atr: (bars, p = 14) => ta.atr(bars, p),
  stdev: (bars, p = 20) => ta.stdev(bars.map(b => b.close), p),
  vwap: (bars) => ta.vwap(bars),
  bb: (bars, p = 20) => ta.bollinger(bars.map(b => b.close), p, 2),
  macd: (bars) => ta.macd(bars.map(b => b.close)),
  supertrend: (bars, p = 10) => ta.supertrend(bars, p, 3),
  adx: (bars, p = 14) => ta.adx(bars, p),
  stoch: (bars, p = 14) => ta.stochastic(bars, p),
  stochrsi: (bars, p = 14) => ta.stochRsi(bars.map(b => b.close), p, p),
  obv: (bars) => ta.obv(bars),
  donchian: (bars, p = 20) => ta.donchian(bars, p),
  keltner: (bars, p = 20) => ta.keltner(bars, p, 2),
  ichimoku: (bars) => ta.ichimoku(bars),
  chop: (bars, p = 14) => ta.choppiness(bars, p),
  bbwidth: (bars, p = 20) => ta.bbWidth(bars.map(b => b.close), p, 2),
  er: (bars, p = 20) => ta.efficiencyRatio(bars.map(b => b.close), p),
  vwapbands: (bars) => ta.vwapBands(bars),
};
const ALIASES = { bollinger: 'bb', dmi: 'adx', stochastic: 'stoch', choppiness: 'chop', ichi: 'ichimoku', st: 'supertrend' };

/** Parse "ema:50" → { name: 'ema', period: 50, key: 'ema_50' }. */
export function parseIndicatorSpec(spec) {
  const [rawName, rawPeriod] = String(spec).trim().toLowerCase().split(/[:(),\s]+/);
  const name = ALIASES[rawName] || rawName;
  if (!INDICATORS[name]) throw new Error(`Unknown indicator "${spec}". Supported: ${Object.keys(INDICATORS).join(', ')} (period with ":", e.g. "ema:50")`);
  const period = rawPeriod ? Number(rawPeriod) : undefined;
  if (period !== undefined && (!Number.isInteger(period) || period < 1 || period > MAX_BARS)) throw new Error(`Invalid period in "${spec}"`);
  return { name, period, key: period ? `${name}_${period}` : name };
}

export async function compute({ indicators, count, history, _deps } = {}) {
  const d = _resolve(_deps);
  const bars = await fetchBars(d, count);
  const specs = (indicators && indicators.length ? indicators : ['rsi', 'atr', 'ema:20', 'ema:50', 'ema:200', 'bb', 'macd']).map(parseIndicatorSpec);
  const n = Math.max(0, Math.min(Number(history) || 0, 50));
  const tail = (arr) => arr.slice(-n).map(v => ta.round(v, 6));
  const values = {};
  for (const s of specs) {
    const out = INDICATORS[s.name](bars, s.period);
    if (Array.isArray(out)) {
      values[s.key] = n ? { value: ta.round(ta.last(out), 6), history: tail(out) } : ta.round(ta.last(out), 6);
    } else {
      const obj = {};
      for (const [k, arr] of Object.entries(out)) obj[k] = n ? { value: ta.round(ta.last(arr), 6), history: tail(arr) } : ta.round(ta.last(arr), 6);
      values[s.key] = obj;
    }
  }
  const lastBar = bars[bars.length - 1];
  return { success: true, bar_count: bars.length, last_bar_time: lastBar.time, close: lastBar.close, values };
}

// ── data_get_key_levels ────────────────────────────────────────────────────

export function computeKeyLevels(bars, { left = 3, right = 3, max_levels = 8 } = {}) {
  if (bars.length < left + right + 5) throw new Error(`Need at least ${left + right + 5} bars to detect levels`);
  const close = bars[bars.length - 1].close;
  const atr = ta.last(ta.atr(bars, 14)) || (bars[bars.length - 1].high - bars[bars.length - 1].low);
  const r = (v) => ta.round(v, 8);

  // Intraday chart → group into days; daily+ chart → each bar is a period.
  const spacing = bars.length > 1 ? bars[bars.length - 1].time - bars[bars.length - 2].time : 0;
  const intraday = spacing > 0 && spacing < 86400;
  const days = intraday ? ta.groupByDay(bars) : bars;
  const prev = days.length >= 2 ? days[days.length - 2] : null;
  const current = days[days.length - 1];

  const result = { close: r(close), atr: r(atr), period_type: intraday ? 'previous_day' : 'previous_bar' };
  if (prev) {
    result.previous_period = { high: r(prev.high), low: r(prev.low), close: r(prev.close), open: r(prev.open) };
    const pv = ta.pivots(prev);
    result.pivots = Object.fromEntries(Object.entries(pv).map(([k, v]) => [k, r(v)]));
  }
  if (intraday && current) result.current_day = { open: r(current.open), high: r(current.high), low: r(current.low) };

  const sw = ta.swingPoints(bars, left, right);
  const zones = ta.clusterLevels([...sw.highs, ...sw.lows], atr * 0.25)
    .map(z => ({ ...z, price: r(z.price), zone_low: r(z.zone_low), zone_high: r(z.zone_high), distance_pct: r(((z.price - close) / close) * 100) }));
  const resistance = zones.filter(z => z.price > close).sort((a, b) => a.price - b.price || b.touches - a.touches).slice(0, max_levels);
  const support = zones.filter(z => z.price <= close).sort((a, b) => b.price - a.price || b.touches - a.touches).slice(0, max_levels);
  result.resistance = resistance;
  result.support = support;
  result.nearest_resistance = resistance[0]?.price ?? null;
  result.nearest_support = support[0]?.price ?? null;
  result.range_high = r(Math.max(...bars.map(b => b.high)));
  result.range_low = r(Math.min(...bars.map(b => b.low)));
  return result;
}

export async function keyLevels({ count, left, right, max_levels, _deps } = {}) {
  const d = _resolve(_deps);
  const bars = await fetchBars(d, count || MAX_BARS);
  return { success: true, bar_count: bars.length, ...computeKeyLevels(bars, { left: left || 3, right: right || 3, max_levels: max_levels || 8 }) };
}

// ── chart_multi_timeframe ──────────────────────────────────────────────────

const MTF_FIELDS = ['close', 'change_pct', 'trend', 'rsi', 'atr', 'atr_pct', 'ema20', 'ema50', 'ema200', 'macd_hist', 'high_20', 'low_20', 'rel_volume'];

export function summarizeAlignment(rows) {
  const ok = rows.filter(r => r.trend && r.trend !== 'insufficient_data');
  const up = ok.filter(r => r.trend.endsWith('up')).length;
  const down = ok.filter(r => r.trend.endsWith('down')).length;
  let bias = 'mixed';
  if (ok.length && up === ok.length) bias = 'bullish_aligned';
  else if (ok.length && down === ok.length) bias = 'bearish_aligned';
  else if (up > down) bias = 'leaning_bullish';
  else if (down > up) bias = 'leaning_bearish';
  return { bias, up_count: up, down_count: down, neutral_count: ok.length - up - down, timeframes: ok.length };
}

export function multiTimeframe({ timeframes, count, _deps } = {}) {
  return withChartLock(async () => {
    const d = _resolve(_deps);
    const tfs = (timeframes && timeframes.length ? timeframes : ['W', 'D', '240', '60']).slice(0, MAX_MTF);
    const state = await d.getState();
    const original = state?.resolution;
    const rows = [];
    try {
      for (const tf of tfs) {
        try {
          await d.setTimeframe({ timeframe: tf });
          const bars = await fetchBars(d, count || 300);
          const snap = ta.snapshot(bars);
          const row = { timeframe: tf, bars: bars.length };
          for (const f of MTF_FIELDS) row[f] = snap[f];
          rows.push(row);
        } catch (err) {
          rows.push({ timeframe: tf, error: err.message });
        }
      }
    } finally {
      if (original) { try { await d.setTimeframe({ timeframe: original }); } catch { /* best effort */ } }
    }
    return { success: true, symbol: state?.symbol, restored_timeframe: original, alignment: summarizeAlignment(rows), timeframes: rows };
  });
}

// ── data_correlation ───────────────────────────────────────────────────────

export function correlation({ symbols, count, _deps } = {}) {
  return withChartLock(async () => {
    const d = _resolve(_deps);
    if (!Array.isArray(symbols) || symbols.length < 2) throw new Error('Provide at least 2 symbols');
    const list = symbols.slice(0, 10);
    const state = await d.getState();
    const closes = {};
    const errors = {};
    try {
      for (const s of list) {
        try {
          await d.setSymbol({ symbol: s });
          closes[s] = (await fetchBars(d, count || 200)).map(b => b.close);
        } catch (err) { errors[s] = err.message; }
      }
    } finally {
      if (state?.symbol) { try { await d.setSymbol({ symbol: state.symbol }); } catch { /* best effort */ } }
    }
    const ok = Object.keys(closes);
    const matrix = {};
    const pairs = [];
    for (const a of ok) {
      matrix[a] = {};
      for (const b of ok) {
        const c = a === b ? 1 : ta.round(ta.correlation(closes[a], closes[b]), 4);
        matrix[a][b] = c;
        if (a < b && c != null) pairs.push({ a, b, correlation: c });
      }
    }
    pairs.sort((x, y) => Math.abs(y.correlation) - Math.abs(x.correlation));
    return { success: true, method: 'pearson_log_returns', restored_symbol: state?.symbol, matrix, pairs, ...(Object.keys(errors).length && { errors }) };
  });
}

// ── batch_scan (screener) ──────────────────────────────────────────────────

export function scan({ symbols, condition, timeframe, count, delay_ms, sort_by, _deps } = {}) {
  return withChartLock(async () => {
    const d = _resolve(_deps);
    const conds = condition ? ta.parseConditions(condition) : null;
    let list = symbols;
    let source = 'symbols';
    if (!list || !list.length) {
      const wl = await d.getWatchlist();
      list = (wl?.symbols || []).map(s => s.symbol).filter(Boolean);
      source = 'watchlist';
      if (!list.length) throw new Error('No symbols given and the watchlist is empty or closed (open it with ui_open_panel watchlist).');
    }
    list = list.slice(0, MAX_SCAN_SYMBOLS);

    const state = await d.getState();
    const results = [];
    try {
      if (timeframe) await d.setTimeframe({ timeframe });
      for (const sym of list) {
        try {
          await d.setSymbol({ symbol: sym });
          if (delay_ms) await d.sleep(delay_ms);
          const snap = ta.snapshot(await fetchBars(d, count || 300));
          const row = { symbol: sym, close: snap.close, change_pct: snap.change_pct, rsi: snap.rsi, atr_pct: snap.atr_pct, trend: snap.trend, rel_volume: snap.rel_volume };
          if (conds) {
            const ev = ta.evaluateConditions(conds, snap);
            row.match = ev.pass;
            row.checks = ev.details;
          }
          results.push(row);
        } catch (err) {
          results.push({ symbol: sym, error: err.message });
        }
      }
    } finally {
      try {
        if (state?.symbol) await d.setSymbol({ symbol: state.symbol });
        if (timeframe && state?.resolution) await d.setTimeframe({ timeframe: state.resolution });
      } catch { /* best effort */ }
    }

    if (sort_by) {
      const desc = sort_by.startsWith('-');
      const key = sort_by.replace(/^[-+]/, '');
      results.sort((a, b) => {
        const av = a[key] ?? -Infinity, bv = b[key] ?? -Infinity;
        return desc ? bv - av : av - bv;
      });
    }
    const matches = conds ? results.filter(r => r.match) : results.filter(r => !r.error);
    return {
      success: true, source, timeframe: timeframe || state?.resolution, condition: condition || null,
      scanned: results.length, matched: conds ? matches.length : undefined,
      matches: conds ? matches.map(m => m.symbol) : undefined,
      results,
    };
  });
}
