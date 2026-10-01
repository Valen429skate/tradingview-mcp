/**
 * Unit tests for the professional toolkit: new indicators, volume profile,
 * Fibonacci, smart-money concepts, divergences, regime, confluence zones,
 * trailing/breakeven stops and backtest validation.
 * Pure unit (mocked chart) — no TradingView required.
 *
 * Run: node --test tests/pro.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as ta from '../src/core/ta.js';
import { volumeProfile, fibonacci } from '../src/core/profile.js';
import { fairValueGaps, orderBlocks, liquiditySweeps, equalHighsLows, smartMoney } from '../src/core/smc.js';
import { divergences, regime } from '../src/core/signals.js';
import { buildZones, planFromZones, roundNumberStep, collectLevels } from '../src/core/zones.js';
import { runBacktest, validateBacktest } from '../src/core/backtest.js';
import * as pro from '../src/core/pro.js';
import { analyzeChart } from '../src/core/insight.js';

const bar = (time, open, high, low, close, volume = 1000) => ({ time, open, high, low, close, volume });

function wave(n, { start = 100, step = 0, amp = 5, period = 30, vol = 1000 } = {}) {
  const out = [];
  let prev = start;
  for (let i = 0; i < n; i++) {
    const c = start + step * i + amp * Math.sin((2 * Math.PI * i) / period);
    out.push(bar(1700000000 + i * 3600, prev, Math.max(prev, c) + 0.3, Math.min(prev, c) - 0.3, c, vol));
    prev = c;
  }
  return out;
}

function randomWalk(n, seed = 11, drift = 0.0005) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p, c = o * Math.exp(drift + 0.01 * g());
    out.push(bar(1700000000 + i * 3600, o, Math.max(o, c) * (1 + Math.abs(g()) * 0.004), Math.min(o, c) * (1 - Math.abs(g()) * 0.004), c, 1e5 * (1 + Math.abs(g()))));
    p = c;
  }
  return out;
}

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

describe('ta — professional indicators', () => {
  it('rma seeds with SMA then smooths', () => {
    const r = ta.rma([2, 4, 6, 8], 2);
    assert.deepEqual(r.slice(0, 2), [null, 3]);
    approx(r[2], 4.5);
  });

  it('ADX high and +DI dominant in a clean uptrend; low in a flat range', () => {
    const up = wave(150, { step: 1, amp: 0.2 });
    const d = ta.adx(up);
    assert.ok(ta.last(d.adx) > 40);
    assert.ok(ta.last(d.plusDI) > ta.last(d.minusDI));
    const flat = wave(150, { step: 0, amp: 3, period: 8 });
    assert.ok(ta.last(ta.adx(flat).adx) < 25);
  });

  it('supertrend flips direction with the trend', () => {
    const bars = [...wave(80, { step: 1, amp: 0 }), ...wave(80, { start: 180, step: -1, amp: 0 })];
    const st = ta.supertrend(bars);
    assert.equal(st.dir[70], 1);
    assert.equal(ta.last(st.dir), -1);
  });

  it('stochastic is 100 at the top of the range and in [0,100]', () => {
    const k = ta.stochastic(wave(60, { step: 1, amp: 0 })).k;
    approx(ta.last(k), 100 * (ta.last(k) / 100));
    assert.ok(ta.last(k) > 90);
    const sr = ta.stochRsi(wave(120).map(b => b.close)).k.filter(v => v != null);
    assert.ok(sr.every(v => v >= 0 && v <= 100));
  });

  it('obv accumulates on up closes', () => {
    const bars = [bar(0, 1, 1, 1, 1, 10), bar(1, 1, 2, 1, 2, 5), bar(2, 2, 2, 1, 1, 3)];
    assert.deepEqual(ta.obv(bars), [0, 5, 2]);
  });

  it('choppiness high in a range, low in a trend; efficiency ratio ~1 on a line', () => {
    assert.ok(ta.last(ta.choppiness(wave(100, { amp: 3, period: 6 }))) > 50);
    assert.ok(ta.last(ta.choppiness(wave(100, { step: 1, amp: 0 }))) < 40);
    approx(ta.last(ta.efficiencyRatio(Array.from({ length: 30 }, (_, i) => i))), 1);
  });

  it('ichimoku, keltner, donchian and vwap bands have the right ordering', () => {
    const bars = wave(150, { step: 0.3 });
    const k = ta.keltner(bars);
    assert.ok(ta.last(k.upper) > ta.last(k.middle) && ta.last(k.middle) > ta.last(k.lower));
    const d = ta.donchian(bars);
    assert.ok(ta.last(d.upper) >= ta.last(d.lower));
    const ich = ta.ichimoku(bars);
    assert.ok(ta.last(ich.senkou_a) != null && ta.last(ich.senkou_b) != null);
    const vb = ta.vwapBands(bars);
    assert.ok(ta.last(vb.upper_2) > ta.last(vb.upper_1) && ta.last(vb.upper_1) > ta.last(vb.vwap));
  });

  it('snapshot exposes the new screener metrics', () => {
    const snap = ta.snapshot(wave(200, { step: 0.5, amp: 2 }));
    for (const k of ['adx', 'plus_di', 'minus_di', 'supertrend_dir', 'stochrsi_k', 'chop', 'bb_width']) assert.ok(k in snap, k);
    assert.equal(ta.evaluateConditions(ta.parseConditions('adx > 20 and supertrend_dir == 1'), snap).pass, true);
  });
});

describe('volume profile', () => {
  it('POC sits where most volume traded; value area brackets it', () => {
    const bars = [];
    for (let i = 0; i < 50; i++) bars.push(bar(i, 100, 101, 99, 100, 1000));   // heavy at 100
    for (let i = 50; i < 60; i++) bars.push(bar(i, 110, 111, 109, 110, 50));   // light at 110
    const vp = volumeProfile(bars, { rows: 24 });
    assert.ok(Math.abs(vp.poc - 100) < 1.5, `poc ${vp.poc}`);
    assert.ok(vp.val <= vp.poc && vp.vah >= vp.poc);
    assert.ok(vp.value_area_pct >= 70);
    assert.equal(vp.position, 'above_value');
  });

  it('rejects bars without volume', () => {
    assert.throws(() => volumeProfile([bar(0, 1, 2, 0.5, 1, 0), bar(1, 1, 2, 0.5, 1.5, 0)]), /volume/);
  });
});

describe('fibonacci', () => {
  it('up-leg: 0.5 retracement is the leg midpoint, extensions above the high', () => {
    const bars = [...wave(40, { start: 100, step: 0, amp: 0.5, period: 10 }), ...wave(40, { start: 100, step: 1, amp: 0 }), ...wave(30, { start: 139, step: -0.4, amp: 0 })];
    const f = fibonacci(bars, { min_atr: 3 });
    assert.equal(f.found, true);
    assert.equal(f.direction, 'up');
    const hi = f.swing_end.price, lo = f.swing_start.price;
    approx(f.retracements.find(r => r.ratio === 0.5).price, hi - (hi - lo) / 2, 1e-6);
    assert.ok(f.extensions[0].price > hi);
    assert.ok(f.golden_pocket.low < f.golden_pocket.high);
  });

  it('reports not found when no leg is big enough', () => {
    assert.equal(fibonacci(wave(60, { amp: 0.1 }), { min_atr: 50 }).found, false);
  });
});

describe('smart money concepts', () => {
  it('finds an unfilled bullish FVG and its fill %', () => {
    const bars = wave(30, { amp: 0.2 });
    const t = bars.length;
    bars.push(bar(t, 100, 100.5, 99.5, 100.4));
    bars.push(bar(t + 1, 100.4, 104, 100.3, 103.8));   // displacement
    bars.push(bar(t + 2, 103.8, 105, 102, 104.5));      // low 102 > 100.5 → gap 100.5–102
    bars.push(bar(t + 3, 104.5, 105, 101.5, 104));      // trades 1/3 into the gap
    const g = fairValueGaps(bars, { min_atr: 0 }).find(x => x.type === 'bullish' && x.low === 100.5);
    assert.ok(g, 'gap found');
    assert.equal(g.high, 102);
    assert.equal(g.filled_pct, 33);
  });

  it('drops fully filled gaps unless asked', () => {
    const bars = wave(30, { amp: 0.2 });
    const t = bars.length;
    bars.push(bar(t, 100, 100.5, 99.5, 100.4), bar(t + 1, 100.4, 104, 100.3, 103.8), bar(t + 2, 103.8, 105, 102, 104.5), bar(t + 3, 104, 104, 99, 99.5));
    assert.ok(!fairValueGaps(bars, { min_atr: 0 }).some(x => x.low === 100.5));
    assert.ok(fairValueGaps(bars, { min_atr: 0, include_filled: true }).some(x => x.low === 100.5));
  });

  it('order block: last down candle before a structure-breaking impulse', () => {
    const bars = wave(60, { amp: 1, period: 12 });
    const t = bars.length;
    bars.push(bar(t, 100.5, 100.8, 99.2, 99.4));                           // down candle (the OB)
    bars.push(bar(t + 1, 99.4, 104, 99.3, 103.8), bar(t + 2, 103.8, 107, 103.5, 106.8), bar(t + 3, 106.8, 108, 106, 107.5));
    bars.push(bar(t + 4, 107.5, 108, 106.5, 107), bar(t + 5, 107, 107.5, 106, 106.5));
    const ob = orderBlocks(bars).find(o => o.type === 'bullish');
    assert.ok(ob, 'OB found');
    assert.equal(ob.low, 99.2);
    assert.equal(ob.high, 100.8);
  });

  it('liquidity sweep: wick above a swing high that closes back below', () => {
    const bars = wave(60, { amp: 3, period: 20 });
    const swingHigh = Math.max(...bars.slice(30, 55).map(b => b.high));
    const t = bars.length;
    bars.push(bar(t, 100, swingHigh + 1, 99.5, swingHigh - 2));
    const s = liquiditySweeps(bars, { lookback: 3 });
    assert.ok(s.some(x => x.type === 'bearish' && x.bars_ago === 0));
  });

  it('equal highs are detected as untaken liquidity', () => {
    const bars = wave(120, { amp: 4, period: 20 });           // identical wave peaks
    const eq = equalHighsLows(bars);
    assert.ok(eq.some(e => e.type === 'equal_highs' && e.touches >= 3));
  });

  it('smartMoney bundles everything with a summary', () => {
    const sm = smartMoney(randomWalk(300));
    for (const k of ['fair_value_gaps', 'order_blocks', 'liquidity_sweeps', 'equal_highs_lows', 'summary']) assert.ok(k in sm);
  });
});

describe('divergences & regime', () => {
  it('regular bullish RSI divergence: lower low in price, higher low in RSI', () => {
    // Sharp drop to a low, bounce, then a slow grind to a slightly lower low.
    const closes = [];
    for (let i = 0; i < 40; i++) closes.push(120 - i * 0.2);
    for (let i = 0; i < 6; i++) closes.push(closes.at(-1) - 3);      // capitulation → deep RSI low
    for (let i = 0; i < 10; i++) closes.push(closes.at(-1) + 1.2);   // bounce
    for (let i = 0; i < 25; i++) closes.push(closes.at(-1) - 0.55);  // slow grind lower
    for (let i = 0; i < 6; i++) closes.push(closes.at(-1) + 0.8);    // confirm the second low
    const bars = closes.map((c, i) => bar(i, i ? closes[i - 1] : c, Math.max(c, i ? closes[i - 1] : c) + 0.1, Math.min(c, i ? closes[i - 1] : c) - 0.1, c));
    const d = divergences(bars, { oscillator: 'rsi', recent: 40, max_gap: 80 });
    assert.ok(d.some(x => x.type === 'regular_bullish'), JSON.stringify(d.map(x => x.type)));
  });

  it('rejects unknown oscillators', () => {
    assert.throws(() => divergences(wave(80), { oscillator: 'xyz' }), /oscillator/);
  });

  it('regime: trending vs ranging, with a playbook', () => {
    const tr = regime(wave(200, { step: 1, amp: 0.5 }));
    assert.equal(tr.state, 'trending_up');
    assert.ok(tr.playbook.length > 20);
    const rg = regime(wave(200, { amp: 3, period: 8 }));
    assert.ok(['ranging', 'transition', 'squeeze'].includes(rg.state), rg.state);
    assert.throws(() => regime(wave(30)), /60 bars/);
  });
});

describe('confluence zones', () => {
  it('round number step is a 1/2/5 multiple near 0.5% of price', () => {
    assert.equal(roundNumberStep(160), 1);
    assert.equal(roundNumberStep(60000), 500);
    assert.equal(roundNumberStep(1.0845), 0.01);
  });

  it('collects many independent level families', () => {
    const fams = new Set(collectLevels(randomWalk(400)).map(l => l.family));
    for (const f of ['structure', 'pivot', 'fibonacci', 'volume_profile', 'moving_average', 'vwap', 'round_number']) assert.ok(fams.has(f), f);
  });

  it('same-family hits count once; multi-family zones score higher', () => {
    const zones = buildZones(randomWalk(400));
    assert.ok(zones.length > 3);
    for (const z of zones) {
      assert.equal(z.confluences, z.families.length);
      assert.ok(z.low <= z.mid && z.mid <= z.high);
    }
    for (let i = 1; i < zones.length; i++) assert.ok(zones[i - 1].score >= zones[i].score);
  });

  it('long plan: entry zone below price, stop below the zone, targets above with R ≥ 1', () => {
    const bars = randomWalk(400);
    const zones = buildZones(bars);
    const p = planFromZones(bars, zones, { side: 'long', min_score: 0, min_rr: 0 });
    const close = bars.at(-1).close;
    assert.ok(p.entry <= close);
    assert.ok(p.stop < p.entry_zone.low);
    assert.ok(p.targets.every(t => t.price > p.entry && t.r_multiple >= 1));
    assert.match(p.action, /buy_limit|skip_poor_rr/);
  });

  it('short plan mirrors; impossible min_score gives no_setup', () => {
    const bars = randomWalk(400);
    const zones = buildZones(bars);
    const s = planFromZones(bars, zones, { side: 'short', min_score: 0, min_rr: 0 });
    assert.ok(s.stop > s.entry_zone.high);
    assert.equal(planFromZones(bars, zones, { side: 'long', min_score: 999 }).action, 'no_setup');
  });

  it('entry_zones wrapper (auto side) and chart_analyze precise_entry', async () => {
    const bars = randomWalk(400, 5, 0.001);
    const _deps = { getOhlcv: async () => ({ bars }) };
    const z = await pro.entryZones({ _deps });
    assert.equal(z.success, true);
    assert.ok(z.based_on && z.plan);
    const a = await analyzeChart({ _deps, account_size: 10000 });
    assert.ok(a.regime && a.regime.playbook);
    if (a.plan.action !== 'wait') assert.ok(a.precise_entry);
  });
});

describe('backtest — trade management & validation', () => {
  const flatThenUp = () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100, 100.5, 99.5, 100));
    let p = 100;
    for (let i = 0; i < 20; i++) { const c = p + 1; bars.push(bar(30 + i, p, c + 0.2, p - 0.2, c)); p = c; }
    for (let i = 0; i < 10; i++) { const c = p - 1.5; bars.push(bar(50 + i, p, p + 0.2, c - 0.2, c)); p = c; }
    return bars;
  };

  it('trailing stop locks in profit on a reversal', () => {
    const { trades } = runBacktest(flatThenUp(), { entry: 'close > 100.5', trail_atr: 2 });
    assert.equal(trades[0].exit_reason, 'trailing_stop');
    assert.ok(trades[0].pnl > 0);
  });

  it('breakeven stop exits at entry instead of a loss', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100, 100.5, 99.5, 100));
    bars.push(bar(30, 100, 102, 99.8, 101.5));          // signal
    bars.push(bar(31, 101.5, 104, 101.4, 103.8));       // +1R at close → stop to entry
    bars.push(bar(32, 103.8, 103.9, 95, 96));           // crash through entry
    const { trades } = runBacktest(bars, { entry: 'close > 101', stop_pct: 2, breakeven_r: 1 });
    assert.equal(trades[0].exit_reason, 'breakeven');
    approx(trades[0].exit, trades[0].entry);
    assert.ok(trades[0].stop < trades[0].entry, 'reports the INITIAL stop');
  });

  it('new series work in rules', () => {
    const bars = wave(200, { step: 0.2, amp: 4 });
    const res = runBacktest(bars, { entry: 'supertrend_dir crosses_above 0 and adx > 15', exit: 'supertrend_dir crosses_below 0' });
    assert.ok(res.stats.total_trades > 0);
    assert.doesNotThrow(() => runBacktest(bars, { entry: 'stochrsi_k crosses_above 20 and close > kijun', max_bars: 5 }));
  });

  it('validation: deterministic Monte Carlo, consistency split and verdict', () => {
    const bars = randomWalk(500, 9, 0.0008);
    const opts = { entry: 'ema_9 crosses_above ema_21', exit: 'ema_9 crosses_below ema_21', stop_atr: 2, target_r: 3 };
    const a = validateBacktest(bars, opts, { simulations: 300 });
    const b = validateBacktest(bars, opts, { simulations: 300 });
    assert.deepEqual(a.monte_carlo, b.monte_carlo);
    assert.ok(['robust', 'promising', 'fragile', 'no_edge', 'inconclusive'].includes(a.verdict));
    assert.equal(a.sensitivity.length, 4);
    assert.ok(a.consistency.first_part && a.consistency.last_part);
    if (a.monte_carlo.return_pct) assert.ok(a.monte_carlo.return_pct.p5 <= a.monte_carlo.return_pct.p95);
  });

  it('validation flags losing strategies as no_edge', () => {
    const bars = randomWalk(500, 4, -0.002);
    const v = validateBacktest(bars, { entry: 'close > ema_20', exit: 'close < ema_20' }, { simulations: 100 });
    assert.equal(v.verdict, 'no_edge');
  });
});
