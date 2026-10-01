import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as analysis from '../core/analysis.js';
import * as risk from '../core/risk.js';
import * as exporter from '../core/export.js';
import * as optimizer from '../core/optimize.js';

const run = (fn) => async (args) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

export function registerAnalysisTools(server) {
  server.tool('data_compute', 'Compute indicators locally from chart bars — works even when the indicator is NOT on the chart. Returns latest values (optionally last N history values).', {
    indicators: z.array(z.string()).optional().describe('Indicator specs: sma, ema, rsi, atr, stdev, vwap, bb, macd — period with ":" (e.g. ["rsi:14", "ema:200", "atr"]). Default: rsi, atr, ema:20/50/200, bb, macd'),
    count: z.coerce.number().optional().describe('Bars to use (max 500, default 500). More bars = more accurate EMA/RSI warm-up'),
    history: z.coerce.number().optional().describe('Also return the last N values of each series (max 50, default 0)'),
  }, run(analysis.compute));

  server.tool('data_get_key_levels', 'Auto-detect key price levels from chart bars: previous day/bar high-low-close, classic pivots (P, R1-R3, S1-S3), swing-based support/resistance zones with touch counts, and nearest support/resistance. No Pine indicator needed.', {
    count: z.coerce.number().optional().describe('Bars to analyse (max 500, default 500)'),
    left: z.coerce.number().optional().describe('Swing detection: bars to the left (default 3)'),
    right: z.coerce.number().optional().describe('Swing detection: bars to the right (default 3)'),
    max_levels: z.coerce.number().optional().describe('Max support and resistance levels each (default 8)'),
  }, run(analysis.keyLevels));

  server.tool('chart_multi_timeframe', 'Analyse the current symbol across several timeframes in one call: trend, RSI, ATR, EMAs, MACD per timeframe + an overall alignment bias. Restores the original timeframe afterwards.', {
    timeframes: z.array(z.string()).optional().describe('Timeframes (max 6), default ["W", "D", "240", "60"]'),
    count: z.coerce.number().optional().describe('Bars per timeframe (max 500, default 300)'),
  }, run(analysis.multiTimeframe));

  server.tool('data_correlation', 'Correlation matrix (Pearson on log returns) between symbols on the current timeframe. Switches symbols temporarily and restores the original.', {
    symbols: z.array(z.string()).describe('2-10 symbols, e.g. ["ES1!", "NQ1!", "DXY"]'),
    count: z.coerce.number().optional().describe('Bars per symbol (max 500, default 200)'),
  }, run(analysis.correlation));

  server.tool('batch_scan', 'Screener: scan symbols (or the open watchlist) and filter by conditions on computed metrics. Metrics: close, open, high, low, volume, change_pct, rsi, atr, atr_pct, sma20/50/200, ema20/50/200, bb_upper/middle/lower, macd, macd_signal, macd_hist, avg_volume, rel_volume, high_20, low_20. Restores the original symbol/timeframe.', {
    symbols: z.array(z.string()).optional().describe('Symbols to scan (max 50). Omit to scan the open watchlist'),
    condition: z.string().optional().describe('e.g. "rsi < 30 and close > ema200" or "rel_volume > 2". Omit to just rank symbols'),
    timeframe: z.string().optional().describe('Timeframe to scan on (default: current)'),
    count: z.coerce.number().optional().describe('Bars per symbol (max 500, default 300)'),
    sort_by: z.string().optional().describe('Sort results by a field, prefix "-" for descending (e.g. "-rel_volume", "rsi")'),
    delay_ms: z.coerce.number().optional().describe('Extra wait after each symbol switch (default 0)'),
  }, run(analysis.scan));

  server.tool('risk_position_size', 'Position sizing calculator: quantity, actual risk, R-multiple targets, leverage and break-even win rate. Can derive entry from the last close and stop from ATR, and optionally draw entry/stop/targets on the chart.', {
    account_size: z.coerce.number().describe('Account equity'),
    risk_percent: z.coerce.number().optional().describe('% of account to risk (default 1)'),
    risk_amount: z.coerce.number().optional().describe('Fixed amount to risk (overrides risk_percent)'),
    entry: z.coerce.number().optional().describe('Entry price (default: last close)'),
    stop: z.coerce.number().optional().describe('Stop price (or use atr_multiplier)'),
    side: z.enum(['long', 'short']).optional().describe('Needed only with atr_multiplier when no stop given (default long)'),
    atr_multiplier: z.coerce.number().optional().describe('Derive stop = entry ∓ ATR(14) × multiplier'),
    targets: z.array(z.coerce.number()).optional().describe('Explicit target prices'),
    rr_targets: z.array(z.coerce.number()).optional().describe('Targets as R multiples (default [1, 2, 3])'),
    point_value: z.coerce.number().optional().describe('$ per 1.0 price move per unit — futures multiplier (ES=50, NQ=20, MES=5, CL=1000). Default 1'),
    qty_step: z.coerce.number().optional().describe('Round quantity down to this step (default 1; e.g. 0.001 for crypto, 0.01 for forex lots)'),
    commission_per_unit: z.coerce.number().optional().describe('Round-trip commission per unit'),
    draw: z.coerce.boolean().optional().describe('Draw entry/stop/targets as horizontal lines on the chart'),
  }, run(risk.positionSize));

  server.tool('data_export', 'Export data to a CSV or JSON file in exports/ (for Excel, pandas, etc.). Returns the file path.', {
    type: z.enum(['ohlcv', 'trades', 'strategy', 'equity', 'journal']).optional().describe('What to export (default ohlcv)'),
    format: z.enum(['csv', 'json']).optional().describe('File format (default csv)'),
    count: z.coerce.number().optional().describe('Bars for ohlcv (max 500) / trades (max 20)'),
    filename: z.string().optional().describe('Custom file name (without directory)'),
  }, run(exporter.exportData));

  server.tool('strategy_optimize', 'Grid-search a strategy\'s inputs in the live Strategy Tester and rank combinations by a metric. Restores original inputs afterwards unless apply_best=true. Get input ids from data_get_indicator.', {
    entity_id: z.string().describe('Strategy entity ID (from chart_get_state)'),
    params: z.string().describe('JSON object: input id → array of values or {start, stop, step}. e.g. \'{"in_0": [10, 20, 30], "in_1": {"start": 1, "stop": 3, "step": 0.5}}\''),
    metric: z.string().optional().describe('Rank by: net_profit (default), profit_factor, percent_profitable, sharpe_ratio, sortino_ratio, max_drawdown (lower is better), avg_trade…'),
    min_trades: z.coerce.number().optional().describe('Ignore combinations with fewer trades (default 0)'),
    apply_best: z.coerce.boolean().optional().describe('Leave the best inputs applied (default false: restore original)'),
    settle_ms: z.coerce.number().optional().describe('Wait after each input change for the report to recompute (default 2000)'),
    top: z.coerce.number().optional().describe('How many top results to return (default 10)'),
  }, run(optimizer.optimize));
}
