import { register } from '../router.js';
import * as pro from '../../core/pro.js';

const num = (v) => (v === undefined ? undefined : Number(v));

register('zones', {
  description: 'Precise entry: confluence zones + limit plan (tv zones --side long)',
  options: {
    side: { type: 'string', short: 's', description: 'long / short / auto (default)' },
    'min-score': { type: 'string', description: 'Min zone score (default 3)' },
    'min-rr': { type: 'string', description: 'Min R:R to first target (default 1.5)' },
  },
  handler: (o) => pro.entryZones({ side: o.side || 'auto', min_score: num(o['min-score']), min_rr: num(o['min-rr']) }),
});

register('profile', {
  description: 'Volume profile: POC, value area, HVN/LVN (tv profile -n 200)',
  options: { count: { type: 'string', short: 'n', description: 'Bars' }, rows: { type: 'string', short: 'r', description: 'Price rows' } },
  handler: (o) => pro.volumeProfile({ count: num(o.count), rows: num(o.rows) }),
});

register('fib', {
  description: 'Auto-Fibonacci on the latest swing leg',
  options: { 'min-atr': { type: 'string', description: 'Min leg size in ATR (default 3)' } },
  handler: (o) => pro.fibonacci({ min_atr: num(o['min-atr']) }),
});

register('smc', {
  description: 'Smart money: FVGs, order blocks, liquidity sweeps, equal highs/lows',
  options: { distance: { type: 'string', short: 'd', description: 'Max distance % (default 10)' } },
  handler: (o) => pro.smartMoney({ max_distance_pct: num(o.distance) }),
});

register('divergences', {
  description: 'RSI/MACD/OBV/Stoch divergences (tv divergences -o rsi)',
  options: { oscillator: { type: 'string', short: 'o', description: 'rsi, macd, obv, stoch, all (default)' } },
  handler: (o) => pro.divergences({ oscillator: o.oscillator || 'all' }),
});

register('regime', {
  description: 'Market regime (trend / range / squeeze) + playbook',
  handler: () => pro.marketRegime({}),
});

register('validate', {
  description: 'Validate a backtest: consistency, Monte Carlo, sensitivity (tv validate -e "..." -x "..." --stop-atr 2)',
  options: {
    entry: { type: 'string', short: 'e', description: 'Entry rule' },
    exit: { type: 'string', short: 'x', description: 'Exit rule' },
    side: { type: 'string', description: 'long / short' },
    'stop-atr': { type: 'string', description: 'Stop = ATR × n' },
    'target-r': { type: 'string', description: 'Target = n R' },
    'trail-atr': { type: 'string', description: 'Trailing stop ATR × n' },
    'breakeven-r': { type: 'string', description: 'Breakeven at +n R' },
  },
  handler: (o) => pro.validateBacktest({
    entry: o.entry, exit: o.exit, side: o.side, stop_atr: num(o['stop-atr']), target_r: num(o['target-r']),
    trail_atr: num(o['trail-atr']), breakeven_r: num(o['breakeven-r']),
  }),
});
