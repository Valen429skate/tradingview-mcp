/**
 * Unit tests for the analysis/trading toolkit: ta math, key levels,
 * multi-timeframe, screener, correlation, risk, journal, export, optimizer
 * and alert_from_levels. Pure unit (mocked chart) — no TradingView required.
 *
 * Run: node --test tests/analysis.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as ta from '../src/core/ta.js';
import * as analysis from '../src/core/analysis.js';
import { calcPositionSize, positionSize } from '../src/core/risk.js';
import * as journal from '../src/core/journal.js';
import { toCsv, exportData, sanitizeFilename } from '../src/core/export.js';
import { cartesian, expandRanges, rankResults, optimize } from '../src/core/optimize.js';
import { selectLevels, createFromLevels } from '../src/core/alerts.js';

// Deterministic bar generator: sine wave on a trend, 1h spacing.
function makeBars(n = 300, { start = 100, drift = 0.05, amp = 5, period = 40, spacing = 3600, t0 = 1700000000 } = {}) {
  const bars = [];
  let prev = start;
  for (let i = 0; i < n; i++) {
    const close = start + drift * i + amp * Math.sin((2 * Math.PI * i) / period);
    const open = prev;
    bars.push({ time: t0 + i * spacing, open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close, volume: 1000 + (i % 10) * 100 });
    prev = close;
  }
  return bars;
}

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

describe('ta — indicator math', () => {
  it('sma / ema basics', () => {
    assert.deepEqual(ta.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
    const e = ta.ema([1, 2, 3, 4, 5], 3);
    assert.equal(e[2], 2);          // seeded with SMA
    approx(e[3], 3);                // 4*0.5 + 2*0.5
    approx(e[4], 4);
  });

  it('rsi is 100 for monotonic gains, 0 for losses, ~50 when flat-ish', () => {
    const up = Array.from({ length: 30 }, (_, i) => i);
    assert.equal(ta.last(ta.rsi(up, 14)), 100);
    const down = up.map(v => -v);
    assert.equal(ta.last(ta.rsi(down, 14)), 0);
    const flat = Array(30).fill(5);
    assert.equal(ta.last(ta.rsi(flat, 14)), 50);
  });

  it('atr equals constant range for constant bars', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({ time: i, open: 10, high: 11, low: 9, close: 10 }));
    approx(ta.last(ta.atr(bars, 14)), 2);
  });

  it('bollinger bands bracket the middle', () => {
    const bb = ta.bollinger(makeBars(60).map(b => b.close), 20, 2);
    assert.ok(ta.last(bb.upper) > ta.last(bb.middle));
    assert.ok(ta.last(bb.lower) < ta.last(bb.middle));
  });

  it('macd histogram = macd - signal', () => {
    const m = ta.macd(makeBars(100).map(b => b.close));
    approx(ta.last(m.histogram), ta.last(m.macd) - ta.last(m.signal));
  });

  it('correlation: identical = 1, inverse returns = -1', () => {
    const a = makeBars(100).map(b => b.close);
    approx(ta.correlation(a, a), 1);
    const inv = a.map(v => 10000 / v);
    approx(ta.correlation(a, inv), -1, 1e-9);
  });

  it('classic pivots', () => {
    const p = ta.pivots({ high: 110, low: 90, close: 100 });
    assert.equal(p.p, 100);
    assert.equal(p.r1, 110);
    assert.equal(p.s1, 90);
    assert.equal(p.r2, 120);
    assert.equal(p.s2, 80);
  });

  it('swingPoints finds the peaks and troughs of a sine wave', () => {
    const sw = ta.swingPoints(makeBars(200, { drift: 0 }), 3, 3);
    assert.ok(sw.highs.length >= 3 && sw.lows.length >= 3);
  });

  it('swingPoints yields one pivot for a flat top (ties)', () => {
    const highs = [1, 2, 3, 5, 5, 3, 2, 1];
    const bars = highs.map((h, i) => ({ time: i, high: h, low: h - 10 }));
    const sw = ta.swingPoints(bars, 2, 2);
    assert.deepEqual(sw.highs.map(p => p.index), [3]);
  });

  it('clusterLevels merges nearby prices and counts touches', () => {
    const z = ta.clusterLevels([{ price: 100, time: 1 }, { price: 100.2, time: 2 }, { price: 110, time: 3 }], 0.5);
    assert.equal(z.length, 2);
    assert.equal(z[0].touches, 2);
  });

  it('groupByDay aggregates intraday bars', () => {
    const days = ta.groupByDay(makeBars(48, { t0: 1704067200 })); // 2024-01-01 00:00 UTC
    assert.equal(days.length, 2);
    assert.equal(days[0].date, '2024-01-01');
  });

  it('snapshot + trend labels', () => {
    const snap = ta.snapshot(makeBars(300, { drift: 0.5, amp: 1 }));
    assert.ok(['up', 'strong_up'].includes(snap.trend));
    const down = ta.snapshot(makeBars(300, { start: 500, drift: -0.5, amp: 1 }));
    assert.ok(['down', 'strong_down'].includes(down.trend));
    assert.equal(ta.trendLabel({ close: 1 }), 'insufficient_data');
  });
});

describe('ta — screener conditions', () => {
  it('parses and evaluates "and" chains', () => {
    const c = ta.parseConditions('rsi < 30 and close > ema200');
    assert.equal(c.length, 2);
    const ok = ta.evaluateConditions(c, { rsi: 25, close: 110, ema200: 100 });
    assert.equal(ok.pass, true);
    const bad = ta.evaluateConditions(c, { rsi: 35, close: 110, ema200: 100 });
    assert.equal(bad.pass, false);
  });

  it('rejects injection / garbage', () => {
    assert.throws(() => ta.parseConditions('process.exit(1)'));
    assert.throws(() => ta.parseConditions('rsi < 30; drop'));
    assert.throws(() => ta.parseConditions(''));
  });

  it('rejects unknown metrics with a helpful list', () => {
    assert.throws(() => ta.evaluateConditions(ta.parseConditions('foo > 1'), { rsi: 1 }), /Unknown metric "foo".*rsi/);
  });

  it('null metric never passes', () => {
    assert.equal(ta.evaluateConditions(ta.parseConditions('ema200 > 0'), { ema200: null }).pass, false);
  });
});

// ── Mocked chart for analysis.* ──
function mockChart({ bars = makeBars(300), perSymbol = {}, perTf = {}, failSymbols = [] } = {}) {
  const state = { symbol: 'ORIG', resolution: '15' };
  const calls = [];
  return {
    calls, state,
    _deps: {
      getState: async () => ({ ...state }),
      setSymbol: async ({ symbol }) => { calls.push(['sym', symbol]); state.symbol = symbol; },
      setTimeframe: async ({ timeframe }) => { calls.push(['tf', timeframe]); state.resolution = timeframe; },
      getOhlcv: async ({ count }) => {
        if (failSymbols.includes(state.symbol)) throw new Error('no data');
        const b = perSymbol[state.symbol] || perTf[state.resolution] || bars;
        return { bars: b.slice(-(count || 100)) };
      },
      getWatchlist: async () => ({ symbols: [{ symbol: 'W1' }, { symbol: 'W2' }] }),
      sleep: async () => {},
    },
  };
}

describe('analysis.compute()', () => {
  it('returns requested indicators keyed by spec', async () => {
    const { _deps } = mockChart();
    const r = await analysis.compute({ indicators: ['rsi:14', 'ema:50', 'bb', 'macd'], _deps });
    assert.equal(r.success, true);
    assert.ok(typeof r.values.rsi_14 === 'number');
    assert.ok(typeof r.values.ema_50 === 'number');
    assert.ok(r.values.bb.upper > r.values.bb.lower);
    assert.ok('histogram' in r.values.macd);
  });

  it('history returns last N values', async () => {
    const { _deps } = mockChart();
    const r = await analysis.compute({ indicators: ['sma:5'], history: 3, _deps });
    assert.equal(r.values.sma_5.history.length, 3);
  });

  it('rejects unknown indicators and bad periods', () => {
    assert.throws(() => analysis.parseIndicatorSpec('foobar'), /Unknown indicator/);
    assert.throws(() => analysis.parseIndicatorSpec('ema:-1'), /Invalid period/);
    assert.deepEqual(analysis.parseIndicatorSpec('EMA:200'), { name: 'ema', period: 200, key: 'ema_200' });
  });
});

describe('analysis.keyLevels()', () => {
  it('finds support below and resistance above price, plus pivots for intraday', async () => {
    const { _deps } = mockChart({ bars: makeBars(300, { drift: 0 }) });
    const r = await analysis.keyLevels({ _deps });
    assert.equal(r.period_type, 'previous_day');
    assert.ok(r.pivots && r.previous_period);
    for (const s of r.support) assert.ok(s.price <= r.close);
    for (const s of r.resistance) assert.ok(s.price > r.close);
    assert.ok(r.support.length + r.resistance.length > 0);
  });

  it('daily bars use previous bar', () => {
    const r = analysis.computeKeyLevels(makeBars(100, { spacing: 86400 }));
    assert.equal(r.period_type, 'previous_bar');
  });

  it('throws on too few bars', () => {
    assert.throws(() => analysis.computeKeyLevels(makeBars(5)), /at least/);
  });
});

describe('analysis.multiTimeframe()', () => {
  it('reads each timeframe and restores the original', async () => {
    const up = makeBars(300, { drift: 0.5, amp: 1 });
    const m = mockChart({ perTf: { D: up, 60: up } });
    const r = await analysis.multiTimeframe({ timeframes: ['D', '60'], _deps: m._deps });
    assert.equal(r.timeframes.length, 2);
    assert.equal(r.alignment.bias, 'bullish_aligned');
    assert.equal(m.state.resolution, '15');
    assert.deepEqual(m.calls.at(-1), ['tf', '15']);
  });

  it('restores timeframe even when a read fails', async () => {
    const m = mockChart();
    m._deps.getOhlcv = async () => { throw new Error('boom'); };
    const r = await analysis.multiTimeframe({ timeframes: ['D'], _deps: m._deps });
    assert.equal(r.timeframes[0].error, 'boom');
    assert.equal(m.state.resolution, '15');
  });

  it('summarizeAlignment classifies mixed', () => {
    assert.equal(analysis.summarizeAlignment([{ trend: 'up' }, { trend: 'down' }]).bias, 'mixed');
    assert.equal(analysis.summarizeAlignment([{ trend: 'up' }, { trend: 'strong_up' }, { trend: 'down' }]).bias, 'leaning_bullish');
  });
});

describe('analysis.scan()', () => {
  it('filters by condition and restores symbol', async () => {
    const up = makeBars(300, { drift: 0.5, amp: 1 });
    const down = makeBars(300, { start: 500, drift: -0.5, amp: 1 });
    const m = mockChart({ perSymbol: { UP: up, DOWN: down } });
    const r = await analysis.scan({ symbols: ['UP', 'DOWN'], condition: 'close > ema200', _deps: m._deps });
    assert.deepEqual(r.matches, ['UP']);
    assert.equal(m.state.symbol, 'ORIG');
  });

  it('falls back to the watchlist and records per-symbol errors', async () => {
    const m = mockChart({ failSymbols: ['W2'] });
    const r = await analysis.scan({ _deps: m._deps });
    assert.equal(r.source, 'watchlist');
    assert.equal(r.results.length, 2);
    assert.ok(r.results.find(x => x.symbol === 'W2').error);
  });

  it('switches timeframe and restores it', async () => {
    const m = mockChart();
    await analysis.scan({ symbols: ['A'], timeframe: 'D', _deps: m._deps });
    assert.equal(m.state.resolution, '15');
  });

  it('sorts descending with "-" prefix', async () => {
    const m = mockChart({ perSymbol: { A: makeBars(300, { drift: 0.5 }), B: makeBars(300, { start: 500, drift: -0.5 }) } });
    const r = await analysis.scan({ symbols: ['B', 'A'], sort_by: '-rsi', _deps: m._deps });
    assert.ok(r.results[0].rsi >= r.results[1].rsi);
  });
});

describe('analysis.correlation()', () => {
  it('builds a symmetric matrix and restores symbol', async () => {
    const a = makeBars(200);
    const m = mockChart({ perSymbol: { A: a, B: a } });
    const r = await analysis.correlation({ symbols: ['A', 'B'], _deps: m._deps });
    assert.equal(r.matrix.A.B, 1);
    assert.equal(r.pairs[0].correlation, 1);
    assert.equal(m.state.symbol, 'ORIG');
  });

  it('requires 2+ symbols', async () => {
    await assert.rejects(analysis.correlation({ symbols: ['A'], _deps: mockChart()._deps }), /at least 2/);
  });
});

describe('risk — position sizing', () => {
  it('long: 1% of 10k with 2pt stop = 50 units', () => {
    const r = calcPositionSize({ account_size: 10000, risk_percent: 1, entry: 100, stop: 98 });
    assert.equal(r.side, 'long');
    assert.equal(r.quantity, 50);
    assert.equal(r.actual_risk, 100);
    assert.deepEqual(r.targets.map(t => t.price), [102, 104, 106]);
    assert.equal(r.breakeven_win_rate_at_first_target, 50);
  });

  it('short with futures point value and qty rounding down', () => {
    const r = calcPositionSize({ account_size: 50000, risk_amount: 500, entry: 5000, stop: 5004, point_value: 50 });
    assert.equal(r.side, 'short');
    assert.equal(r.quantity, 2);           // 500 / (4*50) = 2.5 → 2
    assert.equal(r.actual_risk, 400);
    assert.equal(r.targets[0].price, 4996);
  });

  it('fractional qty_step for crypto', () => {
    const r = calcPositionSize({ account_size: 1000, risk_percent: 1, entry: 60000, stop: 59000, qty_step: 0.0001 });
    assert.equal(r.quantity, 0.01);        // 10 risk / 1000 per BTC
    const r2 = calcPositionSize({ account_size: 1000, risk_percent: 1, entry: 60000, stop: 58500, qty_step: 0.0001 });
    assert.equal(r2.quantity, 0.0066);     // 0.00666… floored to the step
    assert.equal(r2.warnings, undefined);
  });

  it('warns when one unit is too risky and when target is on the wrong side', () => {
    const r = calcPositionSize({ account_size: 100, risk_percent: 1, entry: 100, stop: 90, targets: [95] });
    assert.equal(r.quantity, 0);
    assert.equal(r.targets[0].valid, false);
    assert.equal(r.warnings.length, 2);
  });

  it('validates inputs', () => {
    assert.throws(() => calcPositionSize({ account_size: 1000, entry: 100, stop: 100 }), /equal/);
    assert.throws(() => calcPositionSize({ account_size: 0, entry: 100, stop: 99 }), /account_size/);
    assert.throws(() => calcPositionSize({ account_size: 100, risk_amount: 200, entry: 100, stop: 99 }), /exceeds/);
  });

  it('derives entry from last close and stop from ATR, and draws the plan', async () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ time: i, open: 100, high: 101, low: 99, close: 100 }));
    const drawn = [];
    const r = await positionSize({
      account_size: 10000, atr_multiplier: 1.5, side: 'short', draw: true,
      _deps: { getOhlcv: async () => ({ bars }), drawShape: async (a) => { drawn.push(a); return { entity_id: 'x' + drawn.length }; } },
    });
    assert.equal(r.entry, 100);
    assert.equal(r.stop, 103);   // ATR 2 * 1.5 above for a short
    assert.equal(r.side, 'short');
    assert.equal(drawn.length, 5); // entry, stop, 3 targets
    assert.equal(drawn[0].shape, 'horizontal_line');
  });
});

describe('journal', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'tvj-')); process.env.TV_JOURNAL_PATH = join(dir, 'trades.json'); });
  after(() => { delete process.env.TV_JOURNAL_PATH; rmSync(dir, { recursive: true, force: true }); });

  it('add → pnl + R multiple', () => {
    const r = journal.add({ symbol: 'ES1!', side: 'buy', entry: 5000, exit: 5010, stop: 4995, quantity: 2, point_value: 50, fees: 10, setup: 'ORB', entry_time: '2024-01-02T15:00:00Z' });
    assert.equal(r.trade.side, 'long');
    assert.equal(r.trade.pnl, 990);
    assert.equal(r.trade.r_multiple, 2);
    assert.equal(r.trade.status, 'closed');
  });

  it('open trade then update with exit', () => {
    const { trade } = journal.add({ symbol: 'NQ1!', side: 'short', entry: 18000, stop: 18020, setup: 'Fade', mistakes: 'moved stop, fomo', entry_time: '2024-01-03T15:00:00Z' });
    assert.equal(trade.status, 'open');
    assert.deepEqual(trade.mistakes, ['moved stop', 'fomo']);
    const u = journal.update({ id: trade.id, exit: 18030 });
    assert.equal(u.trade.pnl, -30);
    assert.equal(u.trade.r_multiple, -1.5);
  });

  it('list filters and stats aggregate', () => {
    assert.equal(journal.list({ symbol: 'es' }).total, 1);
    const s = journal.stats();
    assert.equal(s.closed_trades, 2);
    assert.equal(s.wins, 1);
    assert.equal(s.win_rate, 50);
    assert.equal(s.net_pnl, 960);
    assert.equal(s.profit_factor, 33);
    assert.equal(s.by_setup.ORB.trades, 1);
    assert.equal(s.by_mistake.fomo.trades, 1);
    assert.equal(s.max_drawdown, 30);
    const raw = JSON.parse(readFileSync(process.env.TV_JOURNAL_PATH, 'utf8'));
    assert.equal(raw.trades.length, 2);
  });

  it('delete and validation', () => {
    const { trades } = journal.list();
    journal.remove({ id: trades[0].id });
    assert.equal(journal.list().total, 1);
    assert.throws(() => journal.add({ symbol: 'X', side: 'up', entry: 1 }), /side/);
    assert.throws(() => journal.add({ side: 'long', entry: 1 }), /symbol/);
    assert.throws(() => journal.remove({ id: 'nope' }), /not found/);
  });

  it('computeStats handles no closed trades', () => {
    assert.equal(journal.computeStats([{ symbol: 'X', side: 'long', entry: 1 }]).closed_trades, 0);
  });
});

describe('export', () => {
  it('toCsv escapes and unions columns', () => {
    const csv = toCsv([{ a: 1, b: 'x,y' }, { a: 2, c: 'q"t' }]);
    assert.equal(csv, 'a,b,c\n1,"x,y",\n2,,"q""t"\n');
    assert.equal(toCsv([]), '');
  });

  it('sanitizes filenames', () => {
    assert.equal(sanitizeFilename('../a/b:c d'), '__a_b_c_d');
  });

  it('exports ohlcv to csv with datetime column', async () => {
    const written = {};
    const r = await exportData({
      type: 'ohlcv', filename: 'test',
      _deps: {
        data: { getOhlcv: async () => ({ bars: [{ time: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }] }) },
        getState: async () => ({ symbol: 'AAPL', resolution: 'D' }),
        writeFile: (p, c) => { written.path = p; written.content = c; },
      },
    });
    assert.equal(r.rows, 1);
    assert.ok(written.path.endsWith('test.csv'));
    assert.ok(written.content.startsWith('datetime,time,open'));
    assert.ok(written.content.includes('1970-01-01T00:00:00.000Z'));
  });

  it('rejects bad type/format', async () => {
    await assert.rejects(exportData({ type: 'nope' }), /type must be/);
    await assert.rejects(exportData({ format: 'xml' }), /format must be/);
  });
});

describe('optimizer', () => {
  it('cartesian + ranges', () => {
    assert.equal(cartesian({ a: [1, 2], b: [3, 4, 5] }).length, 6);
    assert.deepEqual(expandRanges({ a: { start: 1, stop: 2, step: 0.5 } }).a, [1, 1.5, 2]);
    assert.throws(() => expandRanges({ a: { start: 1, stop: 2, step: 0 } }), /step/);
  });

  it('rankResults: desc by default, asc for drawdown, honours min_trades', () => {
    const rs = [
      { inputs: { a: 1 }, metrics: { net_profit: 10, max_drawdown: 5, total_trades: 3 } },
      { inputs: { a: 2 }, metrics: { net_profit: 20, max_drawdown: 8, total_trades: 1 } },
    ];
    assert.equal(rankResults(rs, 'net_profit')[0].inputs.a, 2);
    assert.equal(rankResults(rs, 'max_drawdown')[0].inputs.a, 1);
    assert.equal(rankResults(rs, 'net_profit', 2)[0].inputs.a, 1);
  });

  it('runs the grid, finds the best and restores original inputs', async () => {
    let current = { in_0: 14 };
    const applied = [];
    const r = await optimize({
      entity_id: 'S1', params: '{"in_0": [10, 20, 30]}', settle_ms: 0,
      _deps: {
        getIndicator: async () => ({ inputs: [{ id: 'in_0', value: 14 }, { id: 'in_1', value: 2 }] }),
        setInputs: async ({ inputs }) => { applied.push(inputs); current = { ...current, ...inputs }; },
        getStrategyResults: async () => ({ metrics: { net_profit: current.in_0 === 20 ? 500 : 100, total_trades: 10 } }),
        sleep: async () => {},
      },
    });
    assert.equal(r.best.inputs.in_0, 20);
    assert.equal(r.combinations_tested, 3);
    assert.deepEqual(applied.at(-1), { in_0: 14 });
    assert.equal(r.applied, 'original');
  });

  it('apply_best leaves best inputs, and unknown ids are rejected', async () => {
    const applied = [];
    const deps = {
      getIndicator: async () => ({ inputs: [{ id: 'in_0', value: 14 }] }),
      setInputs: async ({ inputs }) => { applied.push(inputs); },
      getStrategyResults: async () => ({ metrics: { net_profit: applied.at(-1).in_0, total_trades: 5 } }),
      sleep: async () => {},
    };
    const r = await optimize({ entity_id: 'S', params: { in_0: [1, 9] }, apply_best: true, _deps: deps });
    assert.deepEqual(applied.at(-1), { in_0: 9 });
    assert.equal(r.applied, 'best');
    await assert.rejects(optimize({ entity_id: 'S', params: { zz: [1] }, _deps: deps }), /Unknown input/);
    await assert.rejects(optimize({ entity_id: 'S', params: { in_0: { start: 1, stop: 200 } }, _deps: deps }), /exceeds/);
  });
});

describe('alert_from_levels', () => {
  it('selectLevels picks the closest, de-duplicated, within distance', () => {
    const p = selectLevels([101, 101.01, 99, 120, 100, 98], 100, { max_alerts: 3, max_distance_pct: 5 });
    assert.deepEqual(p.map(x => x.price), [101, 99, 98]);
  });

  it('dry_run previews without creating', async () => {
    let created = 0;
    const r = await createFromLevels({
      dry_run: true,
      _deps: {
        getOhlcv: async () => ({ bars: [{ close: 100 }] }),
        getPineLines: async () => ({ studies: [{ name: 'Levels', horizontal_levels: [102, 97, 150] }] }),
        create: async () => { created++; return { success: true }; },
      },
    });
    assert.equal(created, 0);
    assert.deepEqual(r.planned.map(x => x.price), [102, 97]);
    assert.equal(r.planned[0].direction, 'above');
    assert.equal(r.planned[0].origin, 'Levels');
  });

  it('creates alerts from key levels', async () => {
    const made = [];
    const r = await createFromLevels({
      source: 'key_levels', max_alerts: 2,
      _deps: {
        getOhlcv: async () => ({ bars: [{ close: 100 }] }),
        keyLevels: async () => ({ support: [{ price: 99, touches: 3 }], resistance: [{ price: 103, touches: 2 }], pivots: { p: 100.5 } }),
        create: async (a) => { made.push(a); return { success: true, alert_id: made.length }; },
      },
    });
    assert.equal(r.created_count, 2);
    assert.deepEqual(made.map(m => m.price), [100.5, 99]);
    assert.ok(made[0].message.includes('Pivot P'));
  });

  it('reports when no pine levels exist', async () => {
    const r = await createFromLevels({ _deps: { getOhlcv: async () => ({ bars: [{ close: 1 }] }), getPineLines: async () => ({ studies: [] }) } });
    assert.equal(r.success, false);
  });
});
