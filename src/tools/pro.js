import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as pro from '../core/pro.js';

const run = (fn) => async (args) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerProTools(server) {
  server.tool('entry_zones', 'PRECISE ENTRIES: merges every level source (S/R, pivots, prev day H/L, Fibonacci + golden pocket, volume profile POC/VAH/VAL/HVN, unfilled FVGs, order blocks, EMAs, VWAP ±2σ, equal highs/lows, round numbers) into zones scored by how many independent methods agree, then builds a limit-order plan: entry inside the best zone, stop beyond it, targets at opposing zones, R:R check and a confirmation trigger. Use for "where exactly should I enter?".', {
    side: z.enum(['long', 'short', 'auto']).optional().describe('Trade direction. auto (default) = follow chart_analyze verdict'),
    min_score: z.coerce.number().optional().describe('Minimum zone score for an entry (default 3)'),
    max_entry_atr: z.coerce.number().optional().describe('Max distance of the entry zone from price, in ATR (default 3)'),
    min_rr: z.coerce.number().optional().describe('Minimum reward:risk to first target (default 1.5)'),
    top: z.coerce.number().optional().describe('How many zones to list (default 8)'),
    count: z.coerce.number().optional().describe('Bars (max 500, default 500)'),
  }, run(pro.entryZones));

  server.tool('data_volume_profile', 'Volume profile from chart bars: POC (point of control), value area high/low (70%), high/low-volume nodes, and where price sits (above / inside / below value). POC and VA edges are prime reaction levels; LVNs are where price moves fast.', {
    rows: z.coerce.number().optional().describe('Price rows (default 30)'),
    count: z.coerce.number().optional().describe('Bars to profile (max 500, default 500). Use fewer for a session profile'),
    include_rows: z.coerce.boolean().optional().describe('Return the full histogram (default false)'),
  }, run(pro.volumeProfile));

  server.tool('data_fibonacci', 'Auto-Fibonacci on the latest significant swing leg: retracements (0.236–0.786), golden pocket (0.618–0.65), extensions (1.272–2.618) and how deep the current pullback is.', {
    min_atr: z.coerce.number().optional().describe('Minimum leg size in ATR (default 3)'),
    swing_bars: z.coerce.number().optional().describe('Bars each side to confirm a swing (default 5)'),
  }, run(pro.fibonacci));

  server.tool('data_smart_money', 'Smart Money Concepts: unfilled fair value gaps (imbalances), valid order blocks (last opposite candle before a displacement that broke structure), recent liquidity sweeps (stop hunts) and untaken equal highs/lows (liquidity targets).', {
    max_distance_pct: z.coerce.number().optional().describe('Only zones within this % of price (default 10)'),
    lookback: z.coerce.number().optional().describe('Bars to scan (default 150)'),
  }, run(pro.smartMoney));

  server.tool('data_divergences', 'Regular (reversal) and hidden (continuation) divergences between price swings and RSI / MACD histogram / OBV / Stochastic. confirmed_bars_ago is when the signal was actually knowable.', {
    oscillator: z.enum(['rsi', 'macd', 'obv', 'stoch', 'all']).optional().describe('Default all'),
    recent: z.coerce.number().optional().describe('Only divergences completed within this many bars (default 30)'),
  }, run(pro.divergences));

  server.tool('market_regime', 'Classify the market: trending up/down, ranging, squeeze (volatility compression) or transition — from ADX/DMI, Choppiness, efficiency ratio, Bollinger width and ATR percentiles, plus Supertrend — and the matching playbook (trend-follow, mean-revert, or breakout).', {
    count: z.coerce.number().optional().describe('Bars (max 500, default 500)'),
  }, run(pro.marketRegime));

  server.tool('backtest_validate', 'Check whether a backtest edge is REAL: first 70% vs last 30% consistency, Monte Carlo (1000 reshuffles: return/drawdown percentiles, probability of loss) and ±25% parameter sensitivity → verdict robust / promising / fragile / no_edge with reasons. Same rule options as backtest_run.', {
    entry: z.string().describe('Entry rule'),
    exit: z.string().optional().describe('Exit rule'),
    side: z.enum(['long', 'short']).optional(),
    stop_atr: z.coerce.number().optional(), stop_pct: z.coerce.number().optional(),
    target_r: z.coerce.number().optional(), target_pct: z.coerce.number().optional(),
    trail_atr: z.coerce.number().optional().describe('Chandelier trailing stop (ATR multiple)'),
    breakeven_r: z.coerce.number().optional().describe('Move stop to entry at +n R'),
    max_bars: z.coerce.number().optional(),
    risk_percent: z.coerce.number().optional(),
    commission_pct: z.coerce.number().optional(),
    split: z.coerce.number().optional().describe('Fraction for the first part (default 0.7)'),
    simulations: z.coerce.number().optional().describe('Monte Carlo runs (default 1000, max 5000)'),
  }, run(pro.validateBacktest));
}
