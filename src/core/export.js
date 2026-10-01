/**
 * Core export logic — writes chart/strategy/journal data to CSV or JSON files
 * under <repo>/exports/ so they can be opened in Excel, pandas, etc.
 * toCsv() is pure and unit-tested.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as _data from './data.js';
import * as _journal from './journal.js';
import { getState as _getState } from './chart.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EXPORT_DIR = join(dirname(dirname(__dirname)), 'exports');

const TYPES = ['ohlcv', 'trades', 'strategy', 'equity', 'journal'];

function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Array of flat-ish objects → CSV. Header is the union of keys in first-seen order. */
export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [];
  const seen = new Set();
  for (const row of rows) for (const k of Object.keys(row)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  return [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
}

export function sanitizeFilename(name) {
  return String(name).replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '_').replace(/\s+/g, '_');
}

export async function exportData({ type = 'ohlcv', format = 'csv', count, filename, _deps } = {}) {
  const data = _deps?.data || _data;
  const journal = _deps?.journal || _journal;
  const getState = _deps?.getState || _getState;
  const write = _deps?.writeFile || ((p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); });

  if (!TYPES.includes(type)) throw new Error(`type must be one of: ${TYPES.join(', ')}`);
  if (!['csv', 'json'].includes(format)) throw new Error('format must be csv or json');

  let rows, meta = {};
  if (type === 'ohlcv') {
    const res = await data.getOhlcv({ count: count || 500 });
    rows = res.bars.map(b => ({ datetime: new Date(b.time * 1000).toISOString(), ...b }));
  } else if (type === 'trades') {
    const res = await data.getTrades({ max_trades: count || 20 });
    if (res.error && !res.trades?.length) throw new Error(res.error);
    rows = res.trades;
    meta.total_orders = res.total_orders;
  } else if (type === 'strategy') {
    const res = await data.getStrategyResults();
    if (!res.success) throw new Error(res.error || 'No strategy results');
    rows = Object.entries(res.metrics).map(([metric, value]) => ({ metric, value }));
    meta.strategy = res.strategy;
  } else if (type === 'equity') {
    const res = await data.getEquity();
    if (!res.data?.length) throw new Error(res.error || res.note || 'No equity data');
    rows = res.data.map((v, i) => (typeof v === 'object' ? v : { index: i, equity: v }));
  } else {
    rows = journal.list({ limit: 500 }).trades;
  }

  let symbol = null, timeframe = null;
  try { const st = await getState(); symbol = st.symbol; timeframe = st.resolution; } catch { /* offline ok */ }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = sanitizeFilename(filename || [type, symbol, timeframe, ts].filter(Boolean).join('_'));
  const file = join(EXPORT_DIR, base.endsWith('.' + format) ? base : `${base}.${format}`);
  const content = format === 'csv' ? toCsv(rows) : JSON.stringify({ type, symbol, timeframe, exported_at: new Date().toISOString(), ...meta, rows }, null, 2);
  write(file, content);
  return { success: true, type, format, rows: rows.length, file_path: file, bytes: Buffer.byteLength(content), symbol, timeframe };
}
