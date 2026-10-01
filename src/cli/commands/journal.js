import { register } from '../router.js';
import * as core from '../../core/journal.js';

const num = (v) => (v === undefined ? undefined : Number(v));
const tradeOpts = {
  symbol: { type: 'string', description: 'Symbol' },
  side: { type: 'string', description: 'long/short' },
  entry: { type: 'string', short: 'e', description: 'Entry price' },
  exit: { type: 'string', short: 'x', description: 'Exit price' },
  stop: { type: 'string', short: 's', description: 'Stop price' },
  qty: { type: 'string', short: 'q', description: 'Quantity' },
  'point-value': { type: 'string', description: 'Futures multiplier' },
  fees: { type: 'string', description: 'Fees' },
  setup: { type: 'string', description: 'Setup name' },
  tags: { type: 'string', description: 'Comma list of tags' },
  mistakes: { type: 'string', description: 'Comma list of mistakes' },
  notes: { type: 'string', short: 'n', description: 'Notes' },
  'entry-time': { type: 'string', description: 'ISO time' },
  'exit-time': { type: 'string', description: 'ISO time' },
};
const toTrade = (o) => ({
  symbol: o.symbol, side: o.side, entry: num(o.entry), exit: num(o.exit), stop: num(o.stop),
  quantity: num(o.qty), point_value: num(o['point-value']), fees: num(o.fees), setup: o.setup,
  tags: o.tags, mistakes: o.mistakes, notes: o.notes, entry_time: o['entry-time'], exit_time: o['exit-time'],
});
const filterOpts = {
  symbol: { type: 'string', description: 'Filter by symbol' },
  setup: { type: 'string', description: 'Filter by setup' },
  tag: { type: 'string', description: 'Filter by tag' },
  from: { type: 'string', description: 'From date (ISO)' },
  to: { type: 'string', description: 'To date (ISO)' },
};

register('journal', {
  description: 'Local trade journal (add, update, delete, list, stats)',
  subcommands: new Map([
    ['add', { description: 'Log a trade', options: tradeOpts, handler: (o) => core.add(toTrade(o)) }],
    ['update', { description: 'Update a trade: tv journal update <id> -x 105', options: tradeOpts, handler: (o, pos) => core.update({ id: pos[0], ...toTrade(o) }) }],
    ['delete', { description: 'Delete a trade: tv journal delete <id>', handler: (o, pos) => core.remove({ id: pos[0] }) }],
    ['list', {
      description: 'List trades',
      options: { ...filterOpts, status: { type: 'string', description: 'open/closed' }, limit: { type: 'string', short: 'l', description: 'Max trades' } },
      handler: (o) => core.list({ symbol: o.symbol, setup: o.setup, tag: o.tag, from: o.from, to: o.to, status: o.status, limit: num(o.limit) }),
    }],
    ['stats', { description: 'Performance stats', options: filterOpts, handler: (o) => core.stats({ symbol: o.symbol, setup: o.setup, tag: o.tag, from: o.from, to: o.to }) }],
  ]),
});
