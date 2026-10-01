/**
 * Local rule-based backtester. Runs entirely in Node on chart bars — no Pine
 * Script, no Strategy Tester. Rules use a small, safe expression language:
 *
 *   entry: "ema_20 crosses_above ema_50 and rsi < 70"
 *   exit:  "close crosses_below ema_20 or rsi > 80"
 *
 * Operands: numbers, OHLCV fields, and indicator series with optional period
 * suffix — sma_N, ema_N, rsi_N, atr_N, highest_N / lowest_N (previous N bars,
 * excluding the current one, for breakouts), bb_upper / bb_middle / bb_lower,
 * macd / macd_signal / macd_hist, vwap, prev_close, volume_sma_N.
 * Operators: > >= < <= == != crosses_above crosses_below. Combine with
 * "and" / "or" ("and" binds tighter).
 *
 * Execution model (deliberately conservative):
 *   - signals are evaluated on bar close, orders fill at the NEXT bar's open
 *   - stop / target are checked intrabar; if both are touched in the same bar
 *     the stop is assumed to fill first
 *   - gaps through a stop/target fill at the open
 */
import * as ta from './ta.js';
import { getOhlcv as _getOhlcv } from './data.js';

const r = (v, dp = 4) => ta.round(v, dp);

// ── Series registry ────────────────────────────────────────────────────────

const SERIES = [
  [/^(open|high|low|close|volume)$/, (bars, m) => bars.map(b => b[m[1]] ?? null)],
  [/^prev_close$/, (bars) => bars.map((b, i) => (i ? bars[i - 1].close : null))],
  [/^hl2$/, (bars) => bars.map(b => (b.high + b.low) / 2)],
  [/^sma(?:_(\d+))?$/, (bars, m) => ta.sma(bars.map(b => b.close), +(m[1] || 20))],
  [/^ema(?:_(\d+))?$/, (bars, m) => ta.ema(bars.map(b => b.close), +(m[1] || 20))],
  [/^rsi(?:_(\d+))?$/, (bars, m) => ta.rsi(bars.map(b => b.close), +(m[1] || 14))],
  [/^atr(?:_(\d+))?$/, (bars, m) => ta.atr(bars, +(m[1] || 14))],
  [/^volume_sma(?:_(\d+))?$/, (bars, m) => ta.sma(bars.map(b => b.volume || 0), +(m[1] || 20))],
  [/^highest(?:_(\d+))?$/, (bars, m) => rolling(bars.map(b => b.high), +(m[1] || 20), Math.max)],
  [/^lowest(?:_(\d+))?$/, (bars, m) => rolling(bars.map(b => b.low), +(m[1] || 20), Math.min)],
  [/^bb_(upper|middle|lower)$/, (bars, m) => ta.bollinger(bars.map(b => b.close), 20, 2)[m[1]]],
  [/^macd$/, (bars) => ta.macd(bars.map(b => b.close)).macd],
  [/^macd_signal$/, (bars) => ta.macd(bars.map(b => b.close)).signal],
  [/^macd_hist$/, (bars) => ta.macd(bars.map(b => b.close)).histogram],
  [/^vwap$/, (bars) => ta.vwap(bars)],
  [/^supertrend$/, (bars) => ta.supertrend(bars, 10, 3).line],
  [/^supertrend_dir$/, (bars) => ta.supertrend(bars, 10, 3).dir],
  [/^adx(?:_(\d+))?$/, (bars, m) => ta.adx(bars, +(m[1] || 14)).adx],
  [/^plus_di$/, (bars) => ta.adx(bars, 14).plusDI],
  [/^minus_di$/, (bars) => ta.adx(bars, 14).minusDI],
  [/^stoch_(k|d)$/, (bars, m) => ta.stochastic(bars)[m[1]]],
  [/^stochrsi_(k|d)$/, (bars, m) => ta.stochRsi(bars.map(b => b.close))[m[1]]],
  [/^obv$/, (bars) => ta.obv(bars)],
  [/^obv_ema(?:_(\d+))?$/, (bars, m) => ta.ema(ta.obv(bars), +(m[1] || 20))],
  [/^donchian_(upper|lower|middle)$/, (bars, m) => ta.donchian(bars, 20)[m[1]]],
  [/^keltner_(upper|lower|middle)$/, (bars, m) => ta.keltner(bars, 20, 2)[m[1]]],
  [/^(tenkan|kijun|senkou_a|senkou_b)$/, (bars, m) => ta.ichimoku(bars)[m[1]]],
  [/^chop(?:_(\d+))?$/, (bars, m) => ta.choppiness(bars, +(m[1] || 14))],
  [/^bb_width$/, (bars) => ta.bbWidth(bars.map(b => b.close), 20, 2)],
  [/^er(?:_(\d+))?$/, (bars, m) => ta.efficiencyRatio(bars.map(b => b.close), +(m[1] || 20))],
];

/** Highest/lowest of the PREVIOUS n values (excludes the current bar). */
function rolling(values, n, fn) {
  return values.map((_, i) => (i < n ? null : fn(...values.slice(i - n, i))));
}

export function makeSeriesResolver(bars) {
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    for (const [re, build] of SERIES) {
      const m = name.match(re);
      if (m) {
        if (m[1] && /^\d+$/.test(m[1]) && (+m[1] < 1 || +m[1] > 500)) throw new Error(`Period out of range in "${name}"`);
        const s = build(bars, m);
        cache.set(name, s);
        return s;
      }
    }
    throw new Error(`Unknown series "${name}". Examples: close, ema_50, sma_200, rsi_14, atr, highest_20, lowest_20, bb_upper, macd_hist, vwap, volume_sma_20`);
  };
}

// ── Rule parsing (no eval) ─────────────────────────────────────────────────

const TOKEN = '([A-Za-z_][\\w]*|-?\\d+(?:\\.\\d+)?)';
const COND_RE = new RegExp(`^${TOKEN}\\s+(crosses_above|crosses_below)\\s+${TOKEN}$|^${TOKEN}\\s*(>=|<=|==|!=|>|<)\\s*${TOKEN}$`);

export function parseRule(expr) {
  if (!expr || typeof expr !== 'string') throw new Error('Rule must be a non-empty string, e.g. "ema_20 crosses_above ema_50"');
  return expr.trim().split(/\s+(?:or|OR|\|\|)\s+/).map(group =>
    group.split(/\s+(?:and|AND|&&)\s+/).map(part => {
      const m = part.trim().match(COND_RE);
      if (!m) throw new Error(`Cannot parse "${part.trim()}". Use "<a> <op> <b>" with op one of > >= < <= == != crosses_above crosses_below`);
      return m[1] ? { left: m[1], op: m[2], right: m[3] } : { left: m[4], op: m[5], right: m[6] };
    }));
}

export function compileRule(expr, resolve) {
  const groups = parseRule(expr);
  const operand = (tok) => {
    if (/^-?\d/.test(tok)) { const n = Number(tok); return () => n; }
    const s = resolve(tok);
    return (i) => s[i];
  };
  const compiled = groups.map(g => g.map(c => {
    const L = operand(c.left), R = operand(c.right);
    switch (c.op) {
      case '>': return (i) => L(i) != null && R(i) != null && L(i) > R(i);
      case '>=': return (i) => L(i) != null && R(i) != null && L(i) >= R(i);
      case '<': return (i) => L(i) != null && R(i) != null && L(i) < R(i);
      case '<=': return (i) => L(i) != null && R(i) != null && L(i) <= R(i);
      case '==': return (i) => L(i) != null && L(i) === R(i);
      case '!=': return (i) => L(i) != null && L(i) !== R(i);
      case 'crosses_above': return (i) => i > 0 && [L(i), R(i), L(i - 1), R(i - 1)].every(v => v != null) && L(i - 1) <= R(i - 1) && L(i) > R(i);
      case 'crosses_below': return (i) => i > 0 && [L(i), R(i), L(i - 1), R(i - 1)].every(v => v != null) && L(i - 1) >= R(i - 1) && L(i) < R(i);
      default: throw new Error(`Unknown operator ${c.op}`);
    }
  }));
  return (i) => compiled.some(g => g.every(fn => fn(i)));
}

// ── Engine ─────────────────────────────────────────────────────────────────

/**
 * @param {object[]} bars
 * @param {object} o
 * @param {string} o.entry            entry rule
 * @param {string} [o.exit]           exit rule (optional if stop/target given)
 * @param {'long'|'short'} [o.side]
 * @param {number} [o.stop_atr]       stop = entry ∓ ATR(14) × n
 * @param {number} [o.stop_pct]       stop = entry ∓ n %
 * @param {number} [o.target_r]       target at n × initial risk (needs a stop)
 * @param {number} [o.target_pct]     target at n %
 * @param {number} [o.max_bars]       time stop
 * @param {number} [o.trail_atr]      chandelier trailing stop: extreme since entry ∓ ATR × n
 * @param {number} [o.breakeven_r]    move stop to entry once the trade is +n R
 * @param {number} [o.initial_capital] default 10000
 * @param {number} [o.risk_percent]   size by risk when a stop exists; else all-in
 * @param {number} [o.commission_pct] per side, % of notional (default 0)
 */
export function runBacktest(bars, o) {
  if (!Array.isArray(bars) || bars.length < 30) throw new Error('Need at least 30 bars to backtest');
  const side = o.side === 'short' ? 'short' : 'long';
  const dir = side === 'long' ? 1 : -1;
  if (!o.exit && !o.stop_atr && !o.stop_pct && !o.target_r && !o.target_pct && !o.max_bars && !o.trail_atr) {
    throw new Error('Provide an exit rule and/or stop_atr / stop_pct / trail_atr / target_r / target_pct / max_bars');
  }
  if (o.target_r && !o.stop_atr && !o.stop_pct) throw new Error('target_r needs a stop (stop_atr or stop_pct)');
  if (o.breakeven_r && !o.stop_atr && !o.stop_pct) throw new Error('breakeven_r needs a stop (stop_atr or stop_pct)');

  const resolve = makeSeriesResolver(bars);
  const entryFn = compileRule(o.entry, resolve);
  const exitFn = o.exit ? compileRule(o.exit, resolve) : () => false;
  const atr = resolve('atr_14');
  const capital0 = Number(o.initial_capital) || 10000;
  const commission = (Number(o.commission_pct) || 0) / 100;

  let equity = capital0;
  let pos = null;
  let pendingEntry = false, pendingExit = false;
  const trades = [];
  const curve = [];
  let barsInMarket = 0;

  const closeTrade = (i, price, reason) => {
    const gross = (price - pos.entry) * dir * pos.qty;
    const fees = (pos.entry + price) * pos.qty * commission;
    const pnl = gross - fees;
    equity += pnl;
    trades.push({
      entry_time: pos.time, exit_time: bars[i].time, side,
      entry: r(pos.entry, 8), exit: r(price, 8), qty: r(pos.qty, 6),
      pnl: r(pnl, 2), return_pct: r(((price - pos.entry) * dir / pos.entry) * 100, 3),
      r_multiple: pos.risk ? r((price - pos.entry) * dir / pos.risk, 2) : null,
      bars_held: i - pos.index, exit_reason: reason,
      stop: pos.initialStop != null ? r(pos.initialStop, 8) : null, target: pos.target != null ? r(pos.target, 8) : null,
    });
    pos = null;
  };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];

    // 1) Fill orders queued at the previous close, at this bar's open.
    if (pendingExit && pos) { closeTrade(i, b.open, 'exit_signal'); pendingExit = false; }
    if (pendingEntry && !pos && (o.stop_atr || o.trail_atr) && atr[i - 1] == null) pendingEntry = false; // ATR not warmed up: never enter without the requested stop
    if (pendingEntry && !pos) {
      pendingEntry = false;
      const entry = b.open;
      let stop = null;
      if (o.stop_atr && atr[i - 1] != null) stop = entry - dir * atr[i - 1] * o.stop_atr;
      else if (o.stop_pct) stop = entry * (1 - dir * o.stop_pct / 100);
      else if (o.trail_atr && atr[i - 1] != null) stop = entry - dir * atr[i - 1] * o.trail_atr;
      const risk = stop != null ? Math.abs(entry - stop) : null;
      let target = null;
      if (o.target_r && risk) target = entry + dir * risk * o.target_r;
      else if (o.target_pct) target = entry * (1 + dir * o.target_pct / 100);
      let qty = equity / entry;                                   // all-in by default
      if (o.risk_percent && risk) qty = Math.min(qty, (equity * o.risk_percent / 100) / risk);
      if (qty > 0) pos = { entry, stop, initialStop: stop, target, risk, qty, index: i, time: b.time, extreme: dir === 1 ? b.high : b.low, stopReason: 'stop' };
    }

    // 2) Intrabar stop / target (stop first when both touched — conservative).
    if (pos) {
      barsInMarket++;
      const hitStop = pos.stop != null && (dir === 1 ? b.low <= pos.stop : b.high >= pos.stop);
      const hitTarget = pos.target != null && (dir === 1 ? b.high >= pos.target : b.low <= pos.target);
      if (hitStop) {
        const gapped = dir === 1 ? b.open < pos.stop : b.open > pos.stop;
        closeTrade(i, gapped ? b.open : pos.stop, pos.stopReason);
      } else if (hitTarget) {
        const gapped = dir === 1 ? b.open > pos.target : b.open < pos.target;
        closeTrade(i, gapped ? b.open : pos.target, 'target');
      } else if (o.max_bars && i - pos.index + 1 >= o.max_bars) {
        closeTrade(i, b.close, 'time');
      }
    }

    // 2b) Trade management at this bar's close — applies from the NEXT bar (no lookahead).
    if (pos) {
      pos.extreme = dir === 1 ? Math.max(pos.extreme, b.high) : Math.min(pos.extreme, b.low);
      const better = (a, c) => (a == null ? c : dir === 1 ? Math.max(a, c) : Math.min(a, c));
      if (o.breakeven_r && pos.risk && (b.close - pos.entry) * dir >= o.breakeven_r * pos.risk) {
        const ns = better(pos.stop, pos.entry);
        if (ns !== pos.stop) { pos.stop = ns; pos.stopReason = 'breakeven'; }
      }
      if (o.trail_atr && atr[i] != null) {
        const ns = better(pos.stop, pos.extreme - dir * atr[i] * o.trail_atr);
        if (ns !== pos.stop) { pos.stop = ns; pos.stopReason = 'trailing_stop'; }
      }
    }

    // 3) Evaluate signals on this bar's close for the next bar.
    if (i < bars.length - 1) {
      if (pos && exitFn(i)) pendingExit = true;
      else if (!pos && entryFn(i)) pendingEntry = true;
    }

    const open = pos ? (b.close - pos.entry) * dir * pos.qty : 0;
    curve.push({ time: b.time, equity: equity + open });
  }
  if (pos) closeTrade(bars.length - 1, bars.at(-1).close, 'end_of_data');
  curve[curve.length - 1].equity = equity;

  return { trades, curve, stats: computeBacktestStats(trades, curve, bars, capital0, barsInMarket) };
}

export function computeBacktestStats(trades, curve, bars, capital0, barsInMarket = 0) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let peak = capital0, maxDD = 0;
  for (const p of curve) { peak = Math.max(peak, p.equity); maxDD = Math.max(maxDD, (peak - p.equity) / peak); }
  const final = curve.at(-1)?.equity ?? capital0;
  const rs = trades.filter(t => t.r_multiple != null).map(t => t.r_multiple);
  const bh = ((bars.at(-1).close - bars[0].open) / bars[0].open) * 100;
  const netPct = ((final - capital0) / capital0) * 100;
  return {
    total_trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: trades.length ? r((wins.length / trades.length) * 100, 2) : null,
    net_profit: r(final - capital0, 2),
    net_profit_pct: r(netPct, 2),
    buy_hold_pct: r(bh, 2),
    beats_buy_hold: netPct > bh,
    profit_factor: gl > 0 ? r(gp / gl, 2) : null,   // null = no losing trades
    avg_win: wins.length ? r(gp / wins.length, 2) : null,
    avg_loss: losses.length ? r(-gl / losses.length, 2) : null,
    expectancy: trades.length ? r((gp - gl) / trades.length, 2) : null,
    avg_r: rs.length ? r(rs.reduce((a, b) => a + b, 0) / rs.length, 2) : null,
    max_drawdown_pct: r(maxDD * 100, 2),
    return_over_drawdown: maxDD > 0 ? r(netPct / (maxDD * 100), 2) : null,
    avg_bars_held: trades.length ? r(trades.reduce((s, t) => s + t.bars_held, 0) / trades.length, 1) : null,
    exposure_pct: r((barsInMarket / bars.length) * 100, 1),
    exit_reasons: trades.reduce((acc, t) => ({ ...acc, [t.exit_reason]: (acc[t.exit_reason] || 0) + 1 }), {}),
    initial_capital: capital0,
    final_equity: r(final, 2),
  };
}

/** Downsample an equity curve to at most n points (keeps first/last). */
export function downsample(curve, n = 60) {
  if (curve.length <= n) return curve;
  const step = (curve.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, k) => curve[Math.round(k * step)]);
}

export async function backtest({ count, max_trades_returned = 20, _deps, ...opts } = {}) {
  const getOhlcv = _deps?.getOhlcv || _getOhlcv;
  const { bars } = await getOhlcv({ count: Math.min(count || 500, 500) });
  const res = runBacktest(bars, opts);
  const notes = ['Fills at next bar open; stop assumed before target on the same bar. Past results do not predict future returns.'];
  if (res.stats.total_trades < 20) notes.push(`Only ${res.stats.total_trades} trades — too few for a statistically meaningful result. Try a lower timeframe or looser rules.`);
  return {
    success: true,
    rules: { entry: opts.entry, exit: opts.exit || null, side: opts.side || 'long', stop_atr: opts.stop_atr, stop_pct: opts.stop_pct, target_r: opts.target_r, target_pct: opts.target_pct, max_bars: opts.max_bars },
    bars_tested: bars.length,
    period: { from: bars[0].time, to: bars.at(-1).time },
    stats: res.stats,
    recent_trades: res.trades.slice(-Math.max(0, Math.min(max_trades_returned, 100))),
    equity_curve: downsample(res.curve).map(p => ({ time: p.time, equity: r(p.equity, 2) })),
    notes,
  };
}

// ── Robustness validation ──────────────────────────────────────────────────

function tradeStats(trades) {
  if (!trades.length) return { trades: 0 };
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const rs = trades.filter(t => t.r_multiple != null).map(t => t.r_multiple);
  return {
    trades: trades.length,
    win_rate: r((wins.length / trades.length) * 100, 1),
    profit_factor: gl > 0 ? r(gp / gl, 2) : null,
    net_pnl: r(gp - gl, 2),
    avg_r: rs.length ? r(rs.reduce((a, b) => a + b, 0) / rs.length, 2) : null,
  };
}

function seededRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

/**
 * Is the edge real? Three independent checks:
 *  1. Consistency — stats on the first `split` of the data vs the rest.
 *  2. Monte Carlo — resample the trade sequence (bootstrap) `simulations`
 *     times: distribution of final return and max drawdown, risk of loss.
 *  3. Sensitivity — nudge stop/target/trail ±25%; a real edge survives.
 */
export function validateBacktest(bars, opts, { split = 0.7, simulations = 1000, seed = 7 } = {}) {
  const base = runBacktest(bars, opts);
  const capital0 = base.stats.initial_capital;
  const splitIdx = Math.floor(bars.length * split);
  const splitTime = bars[splitIdx].time;
  const first = tradeStats(base.trades.filter(t => t.entry_time < splitTime));
  const second = tradeStats(base.trades.filter(t => t.entry_time >= splitTime));

  // Per-trade return on equity at the time of the trade.
  let eq = capital0;
  const rets = base.trades.map(t => { const x = t.pnl / eq; eq += t.pnl; return x; });
  let mc = null;
  if (rets.length >= 5) {
    const rand = seededRandom(seed);
    const finals = [], dds = [];
    for (let k = 0; k < simulations; k++) {
      let e = 1, peak = 1, dd = 0;
      for (let j = 0; j < rets.length; j++) {
        e *= 1 + rets[Math.floor(rand() * rets.length)];
        peak = Math.max(peak, e); dd = Math.max(dd, (peak - e) / peak);
      }
      finals.push((e - 1) * 100); dds.push(dd * 100);
    }
    finals.sort((a, b) => a - b); dds.sort((a, b) => a - b);
    mc = {
      simulations,
      return_pct: { p5: r(pct(finals, 0.05), 2), median: r(pct(finals, 0.5), 2), p95: r(pct(finals, 0.95), 2) },
      max_drawdown_pct: { median: r(pct(dds, 0.5), 2), p95: r(pct(dds, 0.95), 2), worst: r(dds.at(-1), 2) },
      probability_of_loss_pct: r((finals.filter(f => f < 0).length / simulations) * 100, 1),
    };
  }

  const sens = [];
  for (const key of ['stop_atr', 'stop_pct', 'target_r', 'target_pct', 'trail_atr']) {
    if (!opts[key]) continue;
    for (const f of [0.75, 1.25]) {
      try {
        const v = r(opts[key] * f, 3);
        const res = runBacktest(bars, { ...opts, [key]: v });
        sens.push({ param: key, value: v, net_profit_pct: res.stats.net_profit_pct, trades: res.stats.total_trades, profit_factor: res.stats.profit_factor });
      } catch { /* skip invalid combos */ }
    }
  }

  // Verdict
  const issues = [], positives = [];
  if (base.stats.total_trades < 20) issues.push(`Only ${base.stats.total_trades} trades — statistically weak.`);
  if (first.trades && second.trades) {
    if ((first.net_pnl > 0) !== (second.net_pnl > 0)) issues.push('Profitable in one half, losing in the other — likely curve-fit or regime-dependent.');
    else if (first.net_pnl > 0) positives.push('Profitable in both the first and last part of the data.');
  } else issues.push('Not enough trades in both halves to compare.');
  if (mc) {
    if (mc.probability_of_loss_pct > 40) issues.push(`Monte Carlo: ${mc.probability_of_loss_pct}% of reshuffled runs lose money.`);
    else if (mc.probability_of_loss_pct < 15) positives.push(`Monte Carlo: only ${mc.probability_of_loss_pct}% of reshuffled runs lose money.`);
  }
  if (sens.length) {
    const sameSign = sens.every(x => (x.net_profit_pct > 0) === (base.stats.net_profit_pct > 0));
    if (!sameSign) issues.push('Small parameter changes flip the result — fragile.');
    else if (base.stats.net_profit_pct > 0) positives.push('Result holds when stop/target are changed ±25%.');
  }
  if (!base.stats.beats_buy_hold) issues.push(`Underperforms buy & hold (${base.stats.net_profit_pct}% vs ${base.stats.buy_hold_pct}%).`);
  let verdict = 'inconclusive';
  if (base.stats.net_profit_pct <= 0) verdict = 'no_edge';
  else if (!issues.length) verdict = 'robust';
  else if (issues.length === 1 && positives.length >= 2) verdict = 'promising';
  else verdict = 'fragile';

  return {
    verdict, positives, issues,
    full_period: { trades: base.stats.total_trades, net_profit_pct: base.stats.net_profit_pct, buy_hold_pct: base.stats.buy_hold_pct, profit_factor: base.stats.profit_factor, max_drawdown_pct: base.stats.max_drawdown_pct, win_rate: base.stats.win_rate },
    consistency: { split_at: splitTime, first_part: first, last_part: second },
    monte_carlo: mc || { note: 'Need at least 5 trades for Monte Carlo.' },
    sensitivity: sens,
  };
}

export async function validate({ count, split, simulations, _deps, ...opts } = {}) {
  const getOhlcv = _deps?.getOhlcv || _getOhlcv;
  const { bars } = await getOhlcv({ count: Math.min(count || 500, 500) });
  return { success: true, rules: { entry: opts.entry, exit: opts.exit || null }, bars_tested: bars.length, ...validateBacktest(bars, opts, { split, simulations: Math.min(simulations || 1000, 5000) }), note: 'Validation reduces, but cannot remove, the risk of overfitting. Confirm on other symbols and timeframes.' };
}
