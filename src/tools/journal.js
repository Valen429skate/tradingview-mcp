import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/journal.js';

const run = (fn) => async (args) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

const tradeFields = {
  symbol: z.string().optional().describe('Symbol, e.g. "ES1!"'),
  side: z.string().optional().describe('long/short (buy/sell accepted)'),
  entry: z.coerce.number().optional().describe('Entry price'),
  exit: z.coerce.number().optional().describe('Exit price (omit while the trade is open)'),
  stop: z.coerce.number().optional().describe('Initial stop — enables R-multiple stats'),
  quantity: z.coerce.number().optional().describe('Units/contracts (default 1)'),
  point_value: z.coerce.number().optional().describe('$ per 1.0 price move per unit (futures multiplier, default 1)'),
  fees: z.coerce.number().optional().describe('Total commissions/fees'),
  entry_time: z.string().optional().describe('ISO date/time or unix seconds (default now)'),
  exit_time: z.string().optional().describe('ISO date/time or unix seconds (default now when exit is set)'),
  setup: z.string().optional().describe('Setup name, e.g. "ORB", "VWAP reclaim"'),
  timeframe: z.string().optional().describe('Chart timeframe used'),
  tags: z.array(z.string()).optional().describe('Free-form tags'),
  mistakes: z.array(z.string()).optional().describe('Mistakes made, e.g. ["moved stop", "FOMO"] — tracked in stats'),
  emotion: z.string().optional().describe('How you felt (calm, fomo, revenge…)'),
  notes: z.string().optional().describe('Notes'),
  screenshot: z.string().optional().describe('Screenshot file path (from capture_screenshot)'),
};

const filterFields = {
  symbol: z.string().optional().describe('Filter by symbol substring'),
  setup: z.string().optional().describe('Filter by setup'),
  tag: z.string().optional().describe('Filter by tag'),
  side: z.enum(['long', 'short']).optional().describe('Filter by side'),
  from: z.string().optional().describe('Entry time from (ISO date)'),
  to: z.string().optional().describe('Entry time to (ISO date)'),
};

export function registerJournalTools(server) {
  server.tool('journal_add', 'Log a trade in the local trade journal (journal/trades.json). Requires symbol, side, entry. Returns pnl and R-multiple when exit is given.', tradeFields, run(core.add));

  server.tool('journal_update', 'Update a journal trade (e.g. add the exit price when closing it)', {
    id: z.string().describe('Trade id (from journal_add / journal_list)'),
    ...tradeFields,
  }, run(core.update));

  server.tool('journal_delete', 'Delete a trade from the journal', {
    id: z.string().describe('Trade id'),
  }, run(core.remove));

  server.tool('journal_list', 'List journal trades (newest first) with pnl and R-multiple', {
    ...filterFields,
    status: z.enum(['open', 'closed']).optional().describe('Filter by status'),
    limit: z.coerce.number().optional().describe('Max trades (default 50)'),
  }, run(core.list));

  server.tool('journal_stats', 'Trading performance stats from the journal: win rate, profit factor, expectancy, avg R, drawdown, streaks, and breakdowns by setup, symbol, side, weekday, hour (UTC) and mistake.', filterFields, run(core.stats));
}
