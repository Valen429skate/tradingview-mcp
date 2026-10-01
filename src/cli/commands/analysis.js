import { register } from '../router.js';
import * as analysis from '../../core/analysis.js';
import * as risk from '../../core/risk.js';
import * as exporter from '../../core/export.js';
import * as optimizer from '../../core/optimize.js';

const num = (v) => (v === undefined ? undefined : Number(v));
const list = (v) => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : undefined);

register('compute', {
  description: 'Compute indicators locally from chart bars (e.g. tv compute -i rsi:14,ema:200,atr)',
  options: {
    indicators: { type: 'string', short: 'i', description: 'Comma list: sma, ema, rsi, atr, stdev, vwap, bb, macd (period with ":")' },
    count: { type: 'string', short: 'n', description: 'Bars to use (max 500)' },
    history: { type: 'string', description: 'Also return last N values' },
  },
  handler: (o) => analysis.compute({ indicators: list(o.indicators), count: num(o.count), history: num(o.history) }),
});

register('levels', {
  description: 'Auto-detect key levels: pivots, previous day H/L/C, support/resistance',
  options: {
    count: { type: 'string', short: 'n', description: 'Bars to analyse (max 500)' },
    max: { type: 'string', short: 'm', description: 'Max support/resistance levels each (default 8)' },
  },
  handler: (o) => analysis.keyLevels({ count: num(o.count), max_levels: num(o.max) }),
});

register('mtf', {
  description: 'Multi-timeframe trend summary (e.g. tv mtf -t W,D,240,60)',
  options: {
    timeframes: { type: 'string', short: 't', description: 'Comma list of timeframes (max 6)' },
    count: { type: 'string', short: 'n', description: 'Bars per timeframe' },
  },
  handler: (o) => analysis.multiTimeframe({ timeframes: list(o.timeframes), count: num(o.count) }),
});

register('correlation', {
  description: 'Correlation matrix between symbols (e.g. tv correlation ES1! NQ1! DXY)',
  options: { count: { type: 'string', short: 'n', description: 'Bars per symbol' } },
  handler: (o, pos) => analysis.correlation({ symbols: pos, count: num(o.count) }),
});

register('scan', {
  description: 'Screener over symbols or watchlist (e.g. tv scan AAPL MSFT -c "rsi < 30")',
  options: {
    condition: { type: 'string', short: 'c', description: 'e.g. "rsi < 30 and close > ema200"' },
    timeframe: { type: 'string', short: 't', description: 'Timeframe to scan on' },
    sort: { type: 'string', short: 's', description: 'Sort field, "-" prefix for descending' },
    count: { type: 'string', short: 'n', description: 'Bars per symbol' },
  },
  handler: (o, pos) => analysis.scan({ symbols: pos.length ? pos : undefined, condition: o.condition, timeframe: o.timeframe, sort_by: o.sort, count: num(o.count) }),
});

register('risk', {
  description: 'Position size calculator (e.g. tv risk -a 10000 -r 1 -e 100 -s 98)',
  options: {
    account: { type: 'string', short: 'a', description: 'Account size' },
    risk: { type: 'string', short: 'r', description: 'Risk % (default 1)' },
    amount: { type: 'string', description: 'Fixed risk amount' },
    entry: { type: 'string', short: 'e', description: 'Entry (default last close)' },
    stop: { type: 'string', short: 's', description: 'Stop price' },
    side: { type: 'string', description: 'long/short (for --atr)' },
    atr: { type: 'string', description: 'ATR multiplier for the stop' },
    targets: { type: 'string', description: 'Comma list of target prices' },
    rr: { type: 'string', description: 'Comma list of R multiples (default 1,2,3)' },
    'point-value': { type: 'string', short: 'p', description: 'Futures multiplier (default 1)' },
    step: { type: 'string', description: 'Quantity step (default 1)' },
    draw: { type: 'boolean', short: 'd', description: 'Draw the plan on the chart' },
  },
  handler: (o) => risk.positionSize({
    account_size: num(o.account), risk_percent: num(o.risk), risk_amount: num(o.amount),
    entry: num(o.entry), stop: num(o.stop), side: o.side, atr_multiplier: num(o.atr),
    targets: list(o.targets)?.map(Number), rr_targets: list(o.rr)?.map(Number),
    point_value: num(o['point-value']), qty_step: num(o.step), draw: o.draw,
  }),
});

register('export', {
  description: 'Export ohlcv|trades|strategy|equity|journal to CSV/JSON in exports/',
  options: {
    type: { type: 'string', short: 't', description: 'ohlcv (default), trades, strategy, equity, journal' },
    format: { type: 'string', short: 'f', description: 'csv (default) or json' },
    count: { type: 'string', short: 'n', description: 'Bars / trades' },
    output: { type: 'string', short: 'o', description: 'File name' },
  },
  handler: (o) => exporter.exportData({ type: o.type, format: o.format, count: num(o.count), filename: o.output }),
});

register('optimize', {
  description: 'Grid-search strategy inputs (e.g. tv optimize <entity_id> -p \'{"in_0":[10,20,30]}\')',
  options: {
    params: { type: 'string', short: 'p', description: 'JSON: input id → values array or {start,stop,step}' },
    metric: { type: 'string', short: 'm', description: 'Ranking metric (default net_profit)' },
    'min-trades': { type: 'string', description: 'Ignore combos with fewer trades' },
    apply: { type: 'boolean', description: 'Keep the best inputs applied' },
    settle: { type: 'string', description: 'ms to wait per combination (default 2000)' },
  },
  handler: (o, pos) => optimizer.optimize({
    entity_id: pos[0], params: o.params, metric: o.metric, min_trades: num(o['min-trades']),
    apply_best: o.apply, settle_ms: num(o.settle),
  }),
});
