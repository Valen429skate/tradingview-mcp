#!/usr/bin/env node
/**
 * Generate a sample HTML report from SYNTHETIC price data — no TradingView
 * needed. Shows what report_generate produces against a live chart.
 *
 *   node scripts/demo-report.js [output-name]
 */
import { generateReport } from '../src/core/report.js';

// Seeded random walk with regime changes (trend up → chop → trend down → recovery).
function syntheticBars(n = 500, seed = 42) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const bars = [];
  let price = 100;
  const t0 = Math.floor(Date.UTC(2026, 5, 1) / 1000);
  for (let i = 0; i < n; i++) {
    const drift = i < 150 ? 0.0012 : i < 260 ? 0 : i < 380 ? -0.0010 : 0.0016;
    const vol = i >= 150 && i < 260 ? 0.006 : 0.009;
    const open = price;
    const close = open * Math.exp(drift + vol * gauss());
    const high = Math.max(open, close) * (1 + Math.abs(gauss()) * vol * 0.6);
    const low = Math.min(open, close) * (1 - Math.abs(gauss()) * vol * 0.6);
    bars.push({ time: t0 + i * 3600 * 4, open, high, low, close, volume: Math.round(1e5 * (1 + Math.abs(gauss()))) });
    price = close;
  }
  return bars;
}

const bars = syntheticBars();
const res = await generateReport({
  filename: process.argv[2] || 'demo_report',
  account_size: 10000, risk_percent: 1,
  backtest: { entry: 'ema_9 crosses_above ema_21 and close > ema_50', exit: 'ema_9 crosses_below ema_21', stop_atr: 2, target_r: 3, risk_percent: 1 },
  _deps: {
    getOhlcv: async ({ count }) => ({ bars: bars.slice(-count) }),
    getState: async () => ({ symbol: 'DEMO:SYNTH', resolution: '240' }),
  },
});
console.log(JSON.stringify(res, null, 2));
