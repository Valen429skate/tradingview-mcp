/**
 * Chart-facing wrappers for the professional analysis modules (profile, smc,
 * signals, zones, backtest validation). Each fetches bars and calls the pure
 * implementation.
 */
import * as profile from './profile.js';
import * as smc from './smc.js';
import * as signals from './signals.js';
import * as zonesMod from './zones.js';
import { validate } from './backtest.js';
import { analyzeChart } from './insight.js';
import { getOhlcv as _getOhlcv } from './data.js';

async function bars(_deps, count) {
  const getOhlcv = _deps?.getOhlcv || _getOhlcv;
  const res = await getOhlcv({ count: Math.min(count || 500, 500) });
  if (!res?.bars?.length) throw new Error('No bars returned from chart');
  return res.bars;
}

export async function volumeProfile({ rows, count, include_rows, _deps } = {}) {
  const vp = profile.volumeProfile(await bars(_deps, count), { rows: rows || 30 });
  if (!include_rows) delete vp.rows;
  return { success: true, ...vp };
}

export async function fibonacci({ min_atr, swing_bars, _deps } = {}) {
  const n = swing_bars || 5;
  return { success: true, ...profile.fibonacci(await bars(_deps), { min_atr: min_atr ?? 3, left: n, right: n }) };
}

export async function smartMoney({ max_distance_pct, lookback, _deps } = {}) {
  return { success: true, ...smc.smartMoney(await bars(_deps), { max_distance_pct, lookback: lookback || 150 }) };
}

export async function divergences({ oscillator = 'all', recent, _deps } = {}) {
  const b = await bars(_deps);
  const oscs = oscillator === 'all' ? ['rsi', 'macd', 'obv'] : [oscillator];
  const list = oscs.flatMap(o => signals.divergences(b, { oscillator: o, recent: recent || 30 })).sort((x, y) => x.bars_ago - y.bars_ago);
  const bull = list.filter(d => d.bias === 'bullish').length, bear = list.length - bull;
  return { success: true, count: list.length, bullish: bull, bearish: bear, divergences: list.slice(0, 12) };
}

export async function marketRegime({ count, _deps } = {}) {
  return { success: true, ...signals.regime(await bars(_deps, count)) };
}

export async function entryZones({ side = 'auto', min_score, max_entry_atr, min_rr, top, count, _deps } = {}) {
  const b = await bars(_deps, count);
  let dir = side;
  let verdict = null;
  if (side === 'auto') {
    const a = await analyzeChart({ _deps: { ...(_deps || {}), getOhlcv: async () => ({ bars: b }) } });
    verdict = { verdict: a.verdict, score: a.score };
    dir = a.verdict.includes('bear') ? 'short' : 'long';
  }
  const zones = zonesMod.buildZones(b);
  const plan = zonesMod.planFromZones(b, zones, { side: dir, min_score: min_score ?? 3, max_entry_atr: max_entry_atr ?? 3, min_rr: min_rr ?? 1.5 });
  return {
    success: true,
    close: b.at(-1).close,
    ...(verdict && { based_on: verdict, ...(verdict.verdict === 'neutral' && { note: 'Verdict is neutral — showing the long-side plan; consider waiting.' }) }),
    plan,
    zones_below: zones.filter(z => z.side === 'below').sort((x, y) => y.mid - x.mid).slice(0, Math.ceil((top || 8) / 2)),
    zones_above: zones.filter(z => z.side === 'above').sort((x, y) => x.mid - y.mid).slice(0, Math.ceil((top || 8) / 2)),
    strongest: zones.slice(0, 3).map(z => ({ low: z.low, high: z.high, score: z.score, side: z.side, sources: z.sources })),
  };
}

export async function validateBacktest(args = {}) {
  return validate(args);
}
