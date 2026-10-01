/**
 * Core trade-journal logic — a local JSON file of trades with performance stats.
 *
 * Storage: TV_JOURNAL_PATH env var, or <repo>/journal/trades.json.
 * Nothing leaves the machine; the file is plain JSON you can edit or back up.
 * computeStats() is pure so it is unit-testable without touching disk.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { round } from './ta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(dirname(dirname(__dirname)), 'journal', 'trades.json');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function journalPath() {
  return process.env.TV_JOURNAL_PATH || DEFAULT_PATH;
}

function load(path = journalPath()) {
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(data) ? data : (data.trades || []);
}

function save(trades, path = journalPath()) {
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so a crash mid-write can't corrupt the journal.
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify({ version: 1, trades }, null, 2));
  renameSync(tmp, path);
}

function toEpoch(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${v}`);
  return Math.floor(t / 1000);
}

/** Derive pnl / R-multiple for a trade record (mutates nothing). */
export function enrich(t) {
  const out = { ...t };
  if (t.exit != null && t.entry != null) {
    const dir = t.side === 'short' ? -1 : 1;
    const qty = t.quantity ?? 1;
    const pv = t.point_value ?? 1;
    const move = (t.exit - t.entry) * dir;
    out.pnl = round(move * qty * pv - (t.fees || 0), 2);
    out.return_pct = round((move / t.entry) * 100, 4);
    if (t.stop != null && t.stop !== t.entry) out.r_multiple = round(move / Math.abs(t.entry - t.stop), 2);
    out.status = 'closed';
  } else {
    out.status = 'open';
  }
  return out;
}

function validate(t) {
  if (!t.symbol) throw new Error('symbol is required');
  if (!['long', 'short'].includes(t.side)) throw new Error('side must be "long" or "short"');
  for (const k of ['entry', 'exit', 'stop', 'quantity', 'point_value', 'fees']) {
    if (t[k] != null && !Number.isFinite(Number(t[k]))) throw new Error(`${k} must be a number`);
  }
  if (t.entry == null) throw new Error('entry is required');
}

const FIELDS = ['symbol', 'side', 'entry', 'exit', 'stop', 'quantity', 'point_value', 'fees', 'entry_time', 'exit_time', 'setup', 'timeframe', 'notes', 'tags', 'screenshot', 'emotion', 'mistakes'];
const NUMERIC = new Set(['entry', 'exit', 'stop', 'quantity', 'point_value', 'fees']);

function pick(input) {
  const t = {};
  for (const k of FIELDS) {
    if (input[k] === undefined) continue;
    if (NUMERIC.has(k)) t[k] = input[k] === null ? null : Number(input[k]);
    else if (k === 'entry_time' || k === 'exit_time') t[k] = toEpoch(input[k]);
    else if (k === 'tags' || k === 'mistakes') t[k] = Array.isArray(input[k]) ? input[k] : String(input[k]).split(',').map(s => s.trim()).filter(Boolean);
    else t[k] = input[k];
  }
  if (t.side) t.side = String(t.side).toLowerCase() === 'sell' ? 'short' : String(t.side).toLowerCase() === 'buy' ? 'long' : String(t.side).toLowerCase();
  return t;
}

export function add(input = {}) {
  const t = pick(input);
  if (t.entry_time == null) t.entry_time = Math.floor(Date.now() / 1000);
  if (t.exit != null && t.exit_time == null) t.exit_time = Math.floor(Date.now() / 1000);
  validate(t);
  const trade = { id: randomUUID().slice(0, 8), created_at: new Date().toISOString(), ...t };
  const trades = load();
  trades.push(trade);
  save(trades);
  return { success: true, trade: enrich(trade), journal_path: journalPath(), total_trades: trades.length };
}

export function update({ id, ...changes } = {}) {
  if (!id) throw new Error('id is required');
  const trades = load();
  const i = trades.findIndex(t => t.id === id);
  if (i < 0) throw new Error(`Trade not found: ${id}`);
  const patch = pick(changes);
  if (patch.exit != null && trades[i].exit_time == null && patch.exit_time == null) patch.exit_time = Math.floor(Date.now() / 1000);
  const merged = { ...trades[i], ...patch, updated_at: new Date().toISOString() };
  validate(merged);
  trades[i] = merged;
  save(trades);
  return { success: true, trade: enrich(merged) };
}

export function remove({ id } = {}) {
  if (!id) throw new Error('id is required');
  const trades = load();
  const kept = trades.filter(t => t.id !== id);
  if (kept.length === trades.length) throw new Error(`Trade not found: ${id}`);
  save(kept);
  return { success: true, removed: id, total_trades: kept.length };
}

export function filterTrades(trades, { symbol, setup, tag, side, status, from, to } = {}) {
  const f = toEpoch(from), tt = toEpoch(to);
  return trades.filter(t => {
    if (symbol && !String(t.symbol).toUpperCase().includes(String(symbol).toUpperCase())) return false;
    if (setup && t.setup !== setup) return false;
    if (tag && !(t.tags || []).includes(tag)) return false;
    if (side && t.side !== side) return false;
    if (status && t.status !== status) return false;
    if (f && (t.entry_time || 0) < f) return false;
    if (tt && (t.entry_time || 0) > tt) return false;
    return true;
  });
}

export function list({ limit, ...filters } = {}) {
  const all = load().map(enrich);
  const trades = filterTrades(all, filters).sort((a, b) => (b.entry_time || 0) - (a.entry_time || 0));
  const n = Math.min(Number(limit) || 50, 500);
  return { success: true, total: trades.length, returned: Math.min(n, trades.length), journal_path: journalPath(), trades: trades.slice(0, n) };
}

function group(trades, keyFn) {
  const g = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (k == null) continue;
    (g[k] ||= []).push(t);
  }
  const out = {};
  for (const [k, arr] of Object.entries(g)) {
    const wins = arr.filter(t => t.pnl > 0).length;
    out[k] = { trades: arr.length, win_rate: round((wins / arr.length) * 100, 2), pnl: round(arr.reduce((s, t) => s + t.pnl, 0), 2) };
  }
  return out;
}

export function computeStats(rawTrades) {
  const closed = rawTrades.map(enrich).filter(t => t.status === 'closed').sort((a, b) => (a.exit_time || a.entry_time || 0) - (b.exit_time || b.entry_time || 0));
  const open = rawTrades.length - closed.length;
  if (!closed.length) return { closed_trades: 0, open_trades: open, note: 'No closed trades yet.' };

  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const net = grossProfit - grossLoss;
  const rs = closed.filter(t => t.r_multiple != null).map(t => t.r_multiple);

  let equity = 0, peak = 0, maxDD = 0, streak = 0, maxLossStreak = 0, maxWinStreak = 0, winStreak = 0;
  for (const t of closed) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
    if (t.pnl < 0) { streak++; winStreak = 0; } else if (t.pnl > 0) { winStreak++; streak = 0; } else { streak = 0; winStreak = 0; }
    maxLossStreak = Math.max(maxLossStreak, streak);
    maxWinStreak = Math.max(maxWinStreak, winStreak);
  }

  const d = (t) => (t.entry_time ? new Date(t.entry_time * 1000) : null);
  return {
    closed_trades: closed.length,
    open_trades: open,
    wins: wins.length,
    losses: losses.length,
    breakeven: closed.length - wins.length - losses.length,
    win_rate: round((wins.length / closed.length) * 100, 2),
    net_pnl: round(net, 2),
    gross_profit: round(grossProfit, 2),
    gross_loss: round(grossLoss, 2),
    profit_factor: grossLoss > 0 ? round(grossProfit / grossLoss, 2) : null,
    avg_win: wins.length ? round(grossProfit / wins.length, 2) : null,
    avg_loss: losses.length ? round(-grossLoss / losses.length, 2) : null,
    payoff_ratio: wins.length && losses.length ? round((grossProfit / wins.length) / (grossLoss / losses.length), 2) : null,
    expectancy: round(net / closed.length, 2),
    avg_r: rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length, 2) : null,
    total_r: rs.length ? round(rs.reduce((a, b) => a + b, 0), 2) : null,
    largest_win: wins.length ? round(Math.max(...wins.map(t => t.pnl)), 2) : null,
    largest_loss: losses.length ? round(Math.min(...losses.map(t => t.pnl)), 2) : null,
    max_drawdown: round(maxDD, 2),
    max_consecutive_losses: maxLossStreak,
    max_consecutive_wins: maxWinStreak,
    by_setup: group(closed, t => t.setup || null),
    by_symbol: group(closed, t => t.symbol),
    by_side: group(closed, t => t.side),
    by_weekday_utc: group(closed, t => (d(t) ? WEEKDAYS[d(t).getUTCDay()] : null)),
    by_hour_utc: group(closed, t => (d(t) ? String(d(t).getUTCHours()).padStart(2, '0') : null)),
    by_mistake: group(closed.flatMap(t => (t.mistakes || []).map(m => ({ ...t, _m: m }))), t => t._m),
  };
}

export function stats(filters = {}) {
  const all = load().map(enrich);
  const trades = filterTrades(all, filters);
  return { success: true, journal_path: journalPath(), filters, ...computeStats(trades) };
}
