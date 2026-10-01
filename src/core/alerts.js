/**
 * Core alert logic.
 *
 * Alerts are created / listed / deleted through TradingView's pricealerts REST API
 * (https://pricealerts.tradingview.com) using the desktop app's authenticated session.
 * Requests are sent as text/plain so the browser does not issue a CORS preflight that
 * the endpoint rejects. The create/delete bodies must be wrapped in a `payload` object.
 */
import { evaluate, evaluateAsync, safeString, requireFinite } from '../connection.js';
import { getPineLines as _getPineLines, getOhlcv as _getOhlcv } from './data.js';
import { keyLevels as _keyLevels } from './analysis.js';

// Map the tool's friendly condition names to TradingView's alert condition types.
const CONDITION_TYPE_MAP = {
  crossing: 'cross', cross: 'cross',
  greater_than: 'greater', greater: 'greater', above: 'greater', '>': 'greater',
  less_than: 'less', less: 'less', below: 'less', '<': 'less',
};

export async function create({ condition, price, message }) {
  const p = requireFinite(price, 'price');
  const condType = CONDITION_TYPE_MAP[String(condition || 'crossing').trim().toLowerCase()] || 'cross';

  return evaluate(`
    (function() {
      try {
        var ms = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
        var sym = (ms.proSymbol && ms.proSymbol()) || (ms.symbol && ms.symbol());
        if (!sym) return { success: false, error: 'Could not read current chart symbol from TradingView' };
        var price = ${JSON.stringify(p)};
        var condType = ${safeString(condType)};
        var msg = ${safeString(message || '')};
        if (!msg) {
          var verb = condType === 'greater' ? 'above' : (condType === 'less' ? 'below' : 'crossing');
          msg = sym.split(':').pop() + ' ' + verb + ' ' + price;
        }
        var cond = { type: condType, frequency: 'on_first_fire', series: [{ type: 'barset' }, { type: 'value', value: price }], resolution: '1' };
        var payload = {
          conditions: [cond],
          symbol: '={"symbol":"' + sym + '"}',
          resolution: '1',
          message: msg,
          sound_file: 'alert/fired', sound_duration: 0,
          popup: true, auto_deactivate: true,
          email: false, sms_over_email: false, mobile_push: true,
          web_hook: null, name: null,
          expiration: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          active: true, ignore_warnings: true
        };
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/create_alert', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: payload }));
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) {}
        if (data.s === 'ok') {
          return { success: true, source: 'internal_api', symbol: sym, price: price, condition: condType, message: msg, alert_id: (data.r && data.r.alert_id) || null };
        }
        return { success: false, source: 'internal_api', error: (data.err && data.err.code) || data.errmsg || ('HTTP ' + x.status), response: (x.responseText || '').slice(0, 200) };
      } catch (e) {
        return { success: false, source: 'internal_api', error: e.message };
      }
    })()
  `);
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all, alert_ids, alert_id } = {}) {
  // Resolve the set of alert ids to delete.
  let ids = [];
  if (Array.isArray(alert_ids)) ids = ids.concat(alert_ids);
  if (alert_id != null) ids.push(alert_id);
  if (delete_all) {
    const listed = await list();
    ids = (listed.alerts || []).map((a) => a.alert_id);
  }
  ids = ids.filter((x) => x != null);
  if (!ids.length) {
    return { success: false, source: 'internal_api', error: delete_all ? 'No alerts to delete.' : 'Provide delete_all: true or an alert_id to delete.' };
  }

  const result = await evaluate(`
    (function() {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/delete_alerts', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } }));
        var data = {}; try { data = JSON.parse(x.responseText); } catch (e) {}
        return { ok: data.s === 'ok', status: x.status, response: (x.responseText || '').slice(0, 200) };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (result && result.ok) {
    return { success: true, source: 'internal_api', deleted_count: ids.length, alert_ids: ids };
  }
  return { success: false, source: 'internal_api', alert_ids: ids, error: (result && (result.error || result.response)) || 'delete failed' };
}

/**
 * Pick which levels to alert on: the `max_alerts` closest to `price`, within
 * `max_distance_pct`, skipping duplicates within `min_gap_pct` of each other.
 * Pure — exported for tests.
 */
export function selectLevels(levels, price, { max_alerts = 5, max_distance_pct = 5, min_gap_pct = 0.05 } = {}) {
  const uniq = [...new Set(levels.filter(Number.isFinite))]
    .map(l => ({ price: l, distance_pct: ((l - price) / price) * 100 }))
    .filter(l => Math.abs(l.distance_pct) <= max_distance_pct && l.price !== price)
    .sort((a, b) => Math.abs(a.distance_pct) - Math.abs(b.distance_pct));
  const picked = [];
  for (const l of uniq) {
    if (picked.some(p => Math.abs(p.price - l.price) / price * 100 < min_gap_pct)) continue;
    picked.push(l);
    if (picked.length >= max_alerts) break;
  }
  return picked;
}

/**
 * Create price alerts on levels from Pine indicators (line.new levels) and/or
 * computed key levels (support/resistance/pivots). dry_run previews without
 * creating anything.
 */
export async function createFromLevels({ source = 'pine', study_filter, max_alerts = 5, max_distance_pct = 5, dry_run = false, message_prefix, _deps } = {}) {
  const getPineLines = _deps?.getPineLines || _getPineLines;
  const getOhlcv = _deps?.getOhlcv || _getOhlcv;
  const keyLevels = _deps?.keyLevels || _keyLevels;
  const createAlert = _deps?.create || create;

  const cap = Math.min(Number(max_alerts) || 5, 20);
  const { bars } = await getOhlcv({ count: 5 });
  const price = bars[bars.length - 1].close;
  const levels = [];
  const origin = new Map();

  if (source === 'pine' || source === 'both') {
    const pine = await getPineLines({ study_filter });
    for (const s of pine.studies || []) for (const l of s.horizontal_levels || []) { levels.push(l); if (!origin.has(l)) origin.set(l, s.name); }
  }
  if (source === 'key_levels' || source === 'both') {
    const kl = await keyLevels({});
    for (const z of [...(kl.support || []), ...(kl.resistance || [])]) { levels.push(z.price); if (!origin.has(z.price)) origin.set(z.price, `S/R (${z.touches} touches)`); }
    for (const [k, v] of Object.entries(kl.pivots || {})) { levels.push(v); if (!origin.has(v)) origin.set(v, `Pivot ${k.toUpperCase()}`); }
    if (kl.previous_period) for (const k of ['high', 'low']) { const v = kl.previous_period[k]; levels.push(v); if (!origin.has(v)) origin.set(v, `Prev ${k}`); }
  }
  if (!['pine', 'key_levels', 'both'].includes(source)) throw new Error('source must be pine, key_levels or both');
  if (!levels.length) {
    return { success: false, error: source === 'pine' ? 'No Pine line levels found. Make sure the indicator is visible, or use source: "key_levels".' : 'No levels found.' };
  }

  const picked = selectLevels(levels, price, { max_alerts: cap, max_distance_pct: Number(max_distance_pct) || 5 });
  const plan = picked.map(l => ({
    price: l.price,
    distance_pct: Math.round(l.distance_pct * 100) / 100,
    origin: origin.get(l.price) || null,
    direction: l.price > price ? 'above' : 'below',
  }));
  if (dry_run) return { success: true, dry_run: true, current_price: price, candidates: levels.length, planned: plan };

  const created = [];
  for (const p of plan) {
    const msg = `${message_prefix ? message_prefix + ' ' : ''}${p.origin ? p.origin + ' ' : ''}level ${p.price} reached`;
    try {
      const res = await createAlert({ condition: 'crossing', price: p.price, message: msg });
      created.push({ ...p, success: !!res?.success, alert_id: res?.alert_id ?? null, ...(res?.error && { error: res.error }) });
    } catch (err) { created.push({ ...p, success: false, error: err.message }); }
  }
  return { success: created.some(c => c.success), current_price: price, created_count: created.filter(c => c.success).length, alerts: created };
}
