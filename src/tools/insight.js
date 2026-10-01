import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as insight from '../core/insight.js';
import * as patterns from '../core/patterns.js';
import * as bt from '../core/backtest.js';
import * as report from '../core/report.js';
import { getOhlcv } from '../core/data.js';

const run = (fn) => async (args) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

const RULE_HELP = 'Operands: numbers, open/high/low/close/volume, prev_close, sma_N, ema_N, rsi_N, atr_N, highest_N / lowest_N (previous N bars), bb_upper/middle/lower, macd, macd_signal, macd_hist, vwap, volume_sma_N. Ops: > >= < <= == != crosses_above crosses_below. Join with and / or.';

export function registerInsightTools(server) {
  server.tool('chart_analyze', 'ONE-CALL full analysis of the current chart: trend, market structure, momentum, candle patterns, key levels (+ optional higher-timeframe alignment) combined into a confluence score (-100…+100) with the reasons, plus a suggested plan (entry, stop beyond a level or ATR, targets at next levels, optional position size). Start here for "analyze my chart" / "should I buy?".', {
    include_mtf: z.coerce.boolean().optional().describe('Also check higher timeframes (switches timeframe temporarily, ~2s per TF). Default false'),
    timeframes: z.array(z.string()).optional().describe('Timeframes for include_mtf (default W, D, 240, 60)'),
    account_size: z.coerce.number().optional().describe('If given, the plan includes position size'),
    risk_percent: z.coerce.number().optional().describe('Risk % for sizing (default 1)'),
    point_value: z.coerce.number().optional().describe('Futures multiplier for sizing (ES=50, NQ=20)'),
    count: z.coerce.number().optional().describe('Bars to analyse (max 500, default 500)'),
  }, run(insight.analyzeChart));

  server.tool('data_detect_patterns', `Detect candlestick patterns (${patterns.PATTERN_NAMES.join(', ')}) in recent bars and read market structure (HH/HL vs LH/LL, break of structure). Reversal patterns only fire against the prior move.`, {
    lookback: z.coerce.number().optional().describe('How many recent bars to scan for patterns (default 20, max 500)'),
    patterns: z.array(z.string()).optional().describe('Only these patterns (default all)'),
    include_neutral: z.coerce.boolean().optional().describe('Include neutral patterns like doji / inside bar (default true)'),
  }, run(async ({ lookback, patterns: only, include_neutral = true }) => {
    const { bars } = await getOhlcv({ count: 500 });
    let found = patterns.detectCandles(bars, { lookback: Math.min(lookback || 20, 500), patterns: only });
    if (!include_neutral) found = found.filter(p => p.bias !== 'neutral');
    const counts = found.reduce((a, p) => ({ ...a, [p.bias]: (a[p.bias] || 0) + 1 }), {});
    return { success: true, bars_scanned: Math.min(lookback || 20, bars.length), counts, patterns: found.reverse(), market_structure: patterns.marketStructure(bars) };
  }));

  server.tool('backtest_run', `Backtest a rule-based strategy locally on the chart's bars (up to 500) — no Pine Script needed. Signals on bar close, fills next bar open, stop checked before target. ${RULE_HELP} Example: entry "ema_20 crosses_above ema_50 and rsi_14 < 70", exit "close crosses_below ema_20", stop_atr 2, target_r 3.`, {
    entry: z.string().describe('Entry rule'),
    exit: z.string().optional().describe('Exit rule (optional if a stop/target/max_bars is set)'),
    side: z.enum(['long', 'short']).optional().describe('Default long'),
    stop_atr: z.coerce.number().optional().describe('Stop at entry ∓ ATR(14) × n'),
    stop_pct: z.coerce.number().optional().describe('Stop at entry ∓ n %'),
    target_r: z.coerce.number().optional().describe('Take profit at n × initial risk (needs a stop)'),
    target_pct: z.coerce.number().optional().describe('Take profit at n %'),
    max_bars: z.coerce.number().optional().describe('Exit after n bars in the trade'),
    risk_percent: z.coerce.number().optional().describe('Size each trade to risk n % of equity (needs a stop). Default: all-in'),
    initial_capital: z.coerce.number().optional().describe('Default 10000'),
    commission_pct: z.coerce.number().optional().describe('Commission per side, % of notional (default 0)'),
    count: z.coerce.number().optional().describe('Bars (max 500, default 500)'),
  }, run(bt.backtest));

  server.tool('report_generate', 'Generate a self-contained visual HTML report of the current chart in reports/: interactive candlestick chart with EMAs, support/resistance, candle patterns, confluence verdict with reasons, suggested plan, and (optionally) a backtest with equity curve and trades. Returns the file path — open it in a browser.', {
    backtest: z.string().optional().describe('Optional JSON backtest spec, e.g. \'{"entry": "ema_9 crosses_above ema_21", "exit": "ema_9 crosses_below ema_21", "stop_atr": 2}\''),
    account_size: z.coerce.number().optional().describe('Adds position size to the plan'),
    risk_percent: z.coerce.number().optional().describe('Risk % for sizing (default 1)'),
    point_value: z.coerce.number().optional().describe('Futures multiplier'),
    filename: z.string().optional().describe('File name (default report_<symbol>_<tf>_<timestamp>.html)'),
  }, run(report.generateReport));
}
