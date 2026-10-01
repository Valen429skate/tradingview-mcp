/**
 * Unit tests for patterns, backtester, confluence analysis and HTML report.
 * Pure unit (mocked chart) — no TradingView required.
 *
 * Run: node --test tests/insight.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectCandles, marketStructure, PATTERN_NAMES } from '../src/core/patterns.js';
import { parseRule, compileRule, makeSeriesResolver, runBacktest, backtest, downsample } from '../src/core/backtest.js';
import { scoreConfluence, buildPlan, analyzeChart } from '../src/core/insight.js';
import { buildReportHtml, generateReport } from '../src/core/report.js';
import { computeKeyLevels } from '../src/core/analysis.js';
import * as ta from '../src/core/ta.js';

const bar = (time, open, high, low, close, volume = 100) => ({ time, open, high, low, close, volume });

function trendBars(n, { start = 100, step = 1, amp = 0, period = 20 } = {}) {
  const out = [];
  let prev = start;
  for (let i = 0; i < n; i++) {
    const c = start + step * i + amp * Math.sin((2 * Math.PI * i) / period);
    out.push(bar(i * 3600, prev, Math.max(prev, c) + 0.3, Math.min(prev, c) - 0.3, c));
    prev = c;
  }
  return out;
}

describe('patterns — candles', () => {
  it('bullish engulfing after a decline', () => {
    const bars = trendBars(30, { start: 200, step: -1 });
    const t = bars.length;
    bars.push(bar(t * 3600, 170, 170.5, 167.5, 168));   // red
    bars.push(bar((t + 1) * 3600, 167.8, 171.5, 167.5, 171)); // green engulfs
    const found = detectCandles(bars, { lookback: 1 });
    assert.ok(found.some(p => p.pattern === 'bullish_engulfing' && p.bias === 'bullish' && p.bars_ago === 0));
  });

  it('does NOT flag bullish engulfing in an uptrend (context matters)', () => {
    const bars = trendBars(30, { start: 100, step: 1 });
    const t = bars.length;
    bars.push(bar(t * 3600, 130, 130.5, 127.5, 128));
    bars.push(bar((t + 1) * 3600, 127.8, 131.5, 127.5, 131));
    assert.ok(!detectCandles(bars, { lookback: 1 }).some(p => p.pattern === 'bullish_engulfing'));
  });

  it('hammer after a decline, doji and inside bar anywhere', () => {
    const bars = trendBars(30, { start: 200, step: -1 });
    const t = bars.length;
    bars.push(bar(t * 3600, 170, 170.3, 165, 170.2));       // long lower wick → hammer
    bars.push(bar((t + 1) * 3600, 170, 170.2, 169.8, 170.01)); // tiny body inside previous → doji + inside bar
    const found = detectCandles(bars, { lookback: 2 });
    const names = found.map(p => p.pattern);
    assert.ok(names.includes('hammer'));
    assert.ok(names.includes('doji'));
    assert.ok(names.includes('inside_bar'));
  });

  it('three white soldiers', () => {
    const bars = trendBars(30, { start: 100, step: 0 });
    const t = bars.length;
    bars.push(bar(t * 3600, 100, 101.1, 99.95, 101));
    bars.push(bar((t + 1) * 3600, 101, 102.1, 100.95, 102));
    bars.push(bar((t + 2) * 3600, 102, 103.1, 101.95, 103));
    assert.ok(detectCandles(bars, { lookback: 1 }).some(p => p.pattern === 'three_white_soldiers'));
  });

  it('rejects unknown pattern names', () => {
    assert.throws(() => detectCandles(trendBars(10), { patterns: ['nope'] }), /Unknown pattern/);
    assert.ok(PATTERN_NAMES.length >= 10);
  });
});

describe('patterns — market structure', () => {
  it('uptrend on rising waves, downtrend on falling waves', () => {
    assert.equal(marketStructure(trendBars(200, { step: 0.5, amp: 5 })).structure, 'uptrend');
    assert.equal(marketStructure(trendBars(200, { start: 300, step: -0.5, amp: 5 })).structure, 'downtrend');
  });

  it('flags a bullish break of structure when close clears the last swing high', () => {
    const bars = trendBars(120, { step: 0, amp: 5 });
    const t = bars.length;
    bars.push(bar(t * 3600, 100, 112, 99.5, 111.5));
    const ms = marketStructure(bars);
    assert.equal(ms.break_of_structure?.direction, 'bullish');
  });
});

describe('backtest — rule language', () => {
  it('parses and/or with crosses', () => {
    const g = parseRule('ema_9 crosses_above ema_21 and rsi < 70 or close > highest_20');
    assert.equal(g.length, 2);
    assert.equal(g[0].length, 2);
    assert.equal(g[0][0].op, 'crosses_above');
  });

  it('rejects code injection and unknown series', () => {
    assert.throws(() => parseRule('require("fs")'));
    assert.throws(() => parseRule('close > 1; process.exit()'));
    assert.throws(() => compileRule('foo > 1', makeSeriesResolver(trendBars(40))), /Unknown series/);
    assert.throws(() => compileRule('ema_9999 > 1', makeSeriesResolver(trendBars(40))), /out of range/);
  });

  it('crosses_above fires exactly on the crossing bar', () => {
    const closes = [5, 5, 5, 5, 11, 12, 13];
    const bars = closes.map((c, i) => bar(i, c, c, c, c));
    const fn = compileRule('close crosses_above 10', makeSeriesResolver(bars));
    assert.deepEqual(closes.map((_, i) => fn(i)), [false, false, false, false, true, false, false]);
  });

  it('highest_N excludes the current bar (breakouts are possible)', () => {
    const bars = [1, 2, 3, 10].map((c, i) => bar(i, c, c, c, c));
    const fn = compileRule('close > highest_3', makeSeriesResolver(bars));
    assert.equal(fn(3), true);
  });
});

describe('backtest — engine execution model', () => {
  // Flat at 100 for 30 bars, then a step that triggers "close > 100".
  function stepBars(after) {
    const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100, 100.5, 99.5, 100));
    after.forEach((b, k) => bars.push(bar(30 + k, ...b)));
    return bars;
  }

  it('signal on close → fill at NEXT bar open', () => {
    const bars = stepBars([[100, 102, 99.8, 101.5], [103, 104, 102.5, 103.5], [103.5, 104, 103, 103.8]]);
    const { trades } = runBacktest(bars, { entry: 'close > 101', max_bars: 1 });
    assert.equal(trades[0].entry, 103);            // open of the bar after the signal
    assert.equal(trades[0].exit_reason, 'time');
  });

  it('stop before target when both touched in the same bar', () => {
    const bars = stepBars([[100, 102, 99.8, 101.5], [101.5, 101.6, 101.4, 101.5], [101.5, 140, 60, 101]]);
    const { trades } = runBacktest(bars, { entry: 'close > 101', stop_pct: 5, target_pct: 5 });
    assert.equal(trades[0].exit_reason, 'stop');
    assert.ok(trades[0].pnl < 0);
  });

  it('gap through the stop fills at the open (worse than the stop)', () => {
    const bars = stepBars([[100, 102, 99.8, 101.5], [101.5, 101.6, 101.4, 101.5], [80, 81, 79, 80.5]]);
    const { trades } = runBacktest(bars, { entry: 'close > 101', stop_pct: 5 });
    assert.equal(trades[0].exit, 80);
  });

  it('target_r uses initial risk; R multiple reported', () => {
    const bars = stepBars([[100, 102, 99.8, 101.5], [101.5, 101.6, 101.4, 101.5], [101.5, 120, 101.4, 119]]);
    const { trades } = runBacktest(bars, { entry: 'close > 101', stop_pct: 1, target_r: 2 });
    assert.equal(trades[0].exit_reason, 'target');
    assert.equal(trades[0].r_multiple, 2);
  });

  it('short side profits on a decline', () => {
    const bars = stepBars([[100, 100.2, 98, 98.5], [98.5, 98.6, 97, 97.2], [97, 97.1, 90, 90.5]]);
    const { trades } = runBacktest(bars, { entry: 'close < 99', side: 'short', max_bars: 2 });
    assert.equal(trades[0].side, 'short');
    assert.ok(trades[0].pnl > 0);
  });

  it('risk_percent sizing risks ~1% of equity per trade', () => {
    const bars = stepBars([[100, 102, 99.8, 101.5], [101.5, 101.6, 101.4, 101.5], [101.5, 101.6, 90, 95]]);
    const { trades, stats } = runBacktest(bars, { entry: 'close > 101', stop_pct: 2, risk_percent: 1 });
    assert.equal(trades[0].exit_reason, 'stop');
    assert.ok(Math.abs(trades[0].pnl + 100) < 0.01, `lost ${trades[0].pnl}`);
    assert.equal(stats.final_equity, 9900);
  });

  it('closes any open position at end of data, equity matches trades', () => {
    const bars = trendBars(200, { step: 0.1, amp: 6, period: 30 });
    const res = runBacktest(bars, { entry: 'ema_9 crosses_above ema_21', exit: 'ema_9 crosses_below ema_21', commission_pct: 0.05 });
    const sum = res.trades.reduce((s, t) => s + t.pnl, 0);
    assert.ok(Math.abs(res.stats.final_equity - (10000 + sum)) < 0.05);
    assert.ok(res.stats.total_trades > 0);
    assert.ok(res.stats.exposure_pct > 0 && res.stats.exposure_pct <= 100);
  });

  it('skips entries before ATR warms up instead of trading without a stop', () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i));
    const { trades } = runBacktest(bars, { entry: 'close > 0', stop_atr: 2 });
    assert.ok(trades.length > 0);
    assert.ok(trades.every(t => t.stop != null));
  });

  it('validates inputs', () => {
    const bars = trendBars(50);
    assert.throws(() => runBacktest(bars.slice(0, 10), { entry: 'close > 1', max_bars: 1 }), /at least 30/);
    assert.throws(() => runBacktest(bars, { entry: 'close > 1' }), /exit rule/);
    assert.throws(() => runBacktest(bars, { entry: 'close > 1', target_r: 2 }), /needs a stop/);
  });

  it('backtest() wrapper adds notes and downsamples the curve', async () => {
    const bars = trendBars(300, { step: 0.2, amp: 4 });
    const r = await backtest({ entry: 'close crosses_above ema_20', exit: 'close crosses_below ema_20', _deps: { getOhlcv: async () => ({ bars }) } });
    assert.equal(r.success, true);
    assert.ok(r.equity_curve.length <= 60);
    assert.ok(r.notes.length >= 1);
    assert.equal(downsample([1, 2, 3], 10).length, 3);
  });
});

describe('insight — confluence + plan', () => {
  const baseSnap = { close: 100, ema20: 99, ema50: 97, ema200: 90, rsi: 60, macd_hist: 0.5, atr: 2, trend: 'strong_up', rel_volume: 1, change_pct: 0.5 };
  const levels = { atr: 2, nearest_support: 95, nearest_resistance: 110, support: [{ price: 95, zone_low: 94.8, zone_high: 95.2, touches: 3 }], resistance: [{ price: 110, zone_low: 109.8, zone_high: 110.2, touches: 2 }, { price: 115, zone_low: 115, zone_high: 115, touches: 1 }] };

  it('scores a clean uptrend as bullish with reasons', () => {
    const c = scoreConfluence({ snap: baseSnap, structure: { structure: 'uptrend' }, patterns: [], levels });
    assert.ok(c.score >= 40);
    assert.equal(c.verdict, 'strong_bullish');
    assert.ok(c.bullish_factors.length >= 3);
    assert.ok(c.bullish_factors.every(f => typeof f.reason === 'string'));
  });

  it('higher-timeframe disagreement drags the score down', () => {
    const a = scoreConfluence({ snap: baseSnap, structure: { structure: 'uptrend' }, patterns: [], levels });
    const b = scoreConfluence({ snap: baseSnap, structure: { structure: 'uptrend' }, patterns: [], levels, mtf: { alignment: { bias: 'bearish_aligned', up_count: 0, down_count: 4 } } });
    assert.equal(a.score - b.score, 20);
  });

  it('long plan: stop beyond support zone, targets at resistances ≥ 1R, sized', () => {
    const p = buildPlan({ verdict: 'bullish', snap: baseSnap, levels }, { account_size: 10000, risk_percent: 1 });
    assert.equal(p.action, 'look_for_long');
    assert.equal(p.stop, 94.3);                 // 94.8 - 0.25*2
    assert.deepEqual(p.targets.map(t => t.price), [110, 115]);
    assert.ok(p.position.quantity > 0);
  });

  it('falls back to ATR stop and R targets when no levels are usable', () => {
    const p = buildPlan({ verdict: 'bearish', snap: baseSnap, levels: { atr: 2, support: [], resistance: [] } });
    assert.equal(p.action, 'look_for_short');
    assert.equal(p.stop, 103);
    assert.deepEqual(p.targets.map(t => t.r_multiple), [2, 3]);
  });

  it('neutral verdict → wait with levels to watch', () => {
    const p = buildPlan({ verdict: 'neutral', snap: baseSnap, levels });
    assert.equal(p.action, 'wait');
    assert.equal(p.watch.breakout_above, 110);
  });

  it('analyzeChart end-to-end on mocked bars', async () => {
    const bars = trendBars(300, { step: 0.3, amp: 3 });
    const r = await analyzeChart({ account_size: 5000, _deps: { getOhlcv: async () => ({ bars }) } });
    assert.equal(r.success, true);
    assert.ok(r.verdict.includes('bullish'));
    assert.ok(r.summary.length > 0);
    assert.ok(r.plan.position);
  });

  it('analyzeChart with MTF failure still returns', async () => {
    const bars = trendBars(300, { step: 0.3, amp: 3 });
    const r = await analyzeChart({ include_mtf: true, _deps: { getOhlcv: async () => ({ bars }), multiTimeframe: async () => { throw new Error('offline'); } } });
    assert.equal(r.multi_timeframe.error, 'offline');
  });
});

describe('report — HTML', () => {
  it('builds a self-contained, escaped, interactive page', () => {
    const bars = trendBars(200, { step: 0.2, amp: 4 });
    const levels = computeKeyLevels(bars);
    const snap = ta.snapshot(bars);
    const analysis = { ...scoreConfluence({ snap, structure: { structure: 'uptrend' }, patterns: [], levels }), plan: { action: 'wait', reason: 'x', watch: {} }, snapshot: snap, structure: { structure: 'uptrend' } };
    const html = buildReportHtml({ symbol: '<script>alert(1)</script>', timeframe: 'D', bars, analysis, levels, patterns: [], generated_at: 'now' });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(!html.includes('<script>alert(1)'), 'symbol must be escaped');
    assert.ok(html.includes('id="price"'));
    assert.ok(html.includes('prefers-color-scheme:dark'));
    assert.ok(!/src="http|href="http/.test(html), 'no external assets');
  });

  it('generateReport writes a file with backtest summary', async () => {
    const bars = trendBars(300, { step: 0.2, amp: 4 });
    let written;
    const r = await generateReport({
      filename: 'x', backtest: '{"entry":"close crosses_above ema_20","exit":"close crosses_below ema_20"}',
      _deps: { getOhlcv: async () => ({ bars }), getState: async () => ({ symbol: 'T', resolution: '60' }), writeFile: (p, c) => { written = { p, c }; } },
    });
    assert.ok(written.p.endsWith('x.html'));
    assert.ok(written.c.includes('Backtest'));
    assert.ok(r.backtest_summary.trades > 0);
  });
});
