import { register } from '../router.js';
import * as insight from '../../core/insight.js';
import * as bt from '../../core/backtest.js';
import * as report from '../../core/report.js';
import * as patterns from '../../core/patterns.js';
import { getOhlcv } from '../../core/data.js';

const num = (v) => (v === undefined ? undefined : Number(v));

register('analyze', {
  description: 'Full one-call analysis with confluence score + plan (tv analyze --mtf -a 10000)',
  options: {
    mtf: { type: 'boolean', description: 'Include higher-timeframe alignment' },
    account: { type: 'string', short: 'a', description: 'Account size (adds position size)' },
    risk: { type: 'string', short: 'r', description: 'Risk % (default 1)' },
    'point-value': { type: 'string', short: 'p', description: 'Futures multiplier' },
  },
  handler: (o) => insight.analyzeChart({ include_mtf: o.mtf, account_size: num(o.account), risk_percent: num(o.risk), point_value: num(o['point-value']) }),
});

register('patterns', {
  description: 'Candlestick patterns + market structure (tv patterns -l 30)',
  options: { lookback: { type: 'string', short: 'l', description: 'Bars to scan (default 20)' } },
  handler: async (o) => {
    const { bars } = await getOhlcv({ count: 500 });
    return { success: true, patterns: patterns.detectCandles(bars, { lookback: num(o.lookback) || 20 }).reverse(), market_structure: patterns.marketStructure(bars) };
  },
});

register('backtest', {
  description: 'Local backtest: tv backtest -e "ema_9 crosses_above ema_21" -x "ema_9 crosses_below ema_21" --stop-atr 2',
  options: {
    entry: { type: 'string', short: 'e', description: 'Entry rule' },
    exit: { type: 'string', short: 'x', description: 'Exit rule' },
    side: { type: 'string', description: 'long (default) / short' },
    'stop-atr': { type: 'string', description: 'Stop = ATR × n' },
    'stop-pct': { type: 'string', description: 'Stop = n %' },
    'target-r': { type: 'string', description: 'Target = n R' },
    'target-pct': { type: 'string', description: 'Target = n %' },
    'max-bars': { type: 'string', description: 'Time stop' },
    risk: { type: 'string', short: 'r', description: 'Risk % per trade' },
    commission: { type: 'string', description: 'Commission % per side' },
  },
  handler: (o) => bt.backtest({
    entry: o.entry, exit: o.exit, side: o.side, stop_atr: num(o['stop-atr']), stop_pct: num(o['stop-pct']),
    target_r: num(o['target-r']), target_pct: num(o['target-pct']), max_bars: num(o['max-bars']),
    risk_percent: num(o.risk), commission_pct: num(o.commission),
  }),
});

register('report', {
  description: 'Visual HTML report in reports/ (tv report -b \'{"entry":"ema_9 crosses_above ema_21","exit":"ema_9 crosses_below ema_21"}\')',
  options: {
    backtest: { type: 'string', short: 'b', description: 'JSON backtest spec' },
    account: { type: 'string', short: 'a', description: 'Account size' },
    output: { type: 'string', short: 'o', description: 'File name' },
  },
  handler: (o) => report.generateReport({ backtest: o.backtest, account_size: num(o.account), filename: o.output }),
});
