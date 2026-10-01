/**
 * Core risk-management logic — position sizing and trade-plan drawing.
 * calcPositionSize() is pure; positionSize() optionally pulls ATR from the
 * chart and draws the plan as horizontal lines.
 */
import * as ta from './ta.js';
import { getOhlcv as _getOhlcv } from './data.js';
import { drawShape as _drawShape } from './drawing.js';

const r = (v, dp = 8) => ta.round(v, dp);

function floorToStep(qty, step) {
  if (!step || step <= 0) return qty;
  const dp = (String(step).split('.')[1] || '').length;
  return Number((Math.floor(qty / step + 1e-9) * step).toFixed(dp));
}

/**
 * @param {object} p
 * @param {number} p.account_size   account equity
 * @param {number} [p.risk_percent] % of account to risk (default 1)
 * @param {number} [p.risk_amount]  fixed amount to risk (overrides risk_percent)
 * @param {number} p.entry
 * @param {number} p.stop
 * @param {number[]} [p.targets]     explicit target prices
 * @param {number[]} [p.rr_targets]  targets as R multiples (default [1, 2, 3])
 * @param {number} [p.point_value]  $ per 1.0 price move per unit (futures multiplier; default 1)
 * @param {number} [p.qty_step]     round quantity down to this step (default 1; use 0.001 for crypto)
 * @param {number} [p.commission_per_unit] round-trip commission per unit
 */
export function calcPositionSize(p) {
  const entry = Number(p.entry), stop = Number(p.stop);
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) throw new Error('entry and stop must be numbers');
  if (entry === stop) throw new Error('entry and stop cannot be equal');
  const account = Number(p.account_size);
  if (!(account > 0)) throw new Error('account_size must be > 0');
  const pointValue = Number(p.point_value) || 1;
  const riskBudget = p.risk_amount != null ? Number(p.risk_amount) : account * (Number(p.risk_percent ?? 1) / 100);
  if (!(riskBudget > 0)) throw new Error('risk must be > 0');
  if (riskBudget > account) throw new Error('risk exceeds account size');

  const side = stop < entry ? 'long' : 'short';
  const dir = side === 'long' ? 1 : -1;
  const stopDist = Math.abs(entry - stop);
  const commission = Number(p.commission_per_unit) || 0;
  const riskPerUnit = stopDist * pointValue + commission;
  const rawQty = riskBudget / riskPerUnit;
  const step = p.qty_step != null ? Number(p.qty_step) : 1;
  const qty = floorToStep(rawQty, step);
  const actualRisk = qty * riskPerUnit;
  const notional = qty * entry * pointValue;

  const targetPrices = (p.targets && p.targets.length)
    ? p.targets.map(Number)
    : (p.rr_targets && p.rr_targets.length ? p.rr_targets : [1, 2, 3]).map(m => entry + dir * stopDist * Number(m));
  const targets = targetPrices.map(t => {
    const reward = (t - entry) * dir;
    return {
      price: r(t),
      r_multiple: r(reward / stopDist, 2),
      profit: r(qty * (reward * pointValue - commission), 2),
      valid: reward > 0,
    };
  });

  const warnings = [];
  if (qty === 0) warnings.push(`Risk budget ${r(riskBudget, 2)} is smaller than the risk of one unit (${r(riskPerUnit, 2)}). Lower qty_step, widen the account risk, or tighten the stop.`);
  if (targets.some(t => !t.valid)) warnings.push('One or more targets are on the wrong side of entry.');
  if (notional > account) warnings.push(`Position notional ${r(notional, 2)} exceeds account size — this needs leverage/margin.`);

  return {
    side,
    entry: r(entry), stop: r(stop),
    stop_distance: r(stopDist), stop_distance_pct: r((stopDist / entry) * 100, 4),
    risk_budget: r(riskBudget, 2),
    quantity: qty,
    raw_quantity: r(rawQty, 6),
    actual_risk: r(actualRisk, 2),
    actual_risk_pct: r((actualRisk / account) * 100, 4),
    notional: r(notional, 2),
    leverage: r(notional / account, 2),
    targets,
    breakeven_win_rate_at_first_target: targets[0]?.valid ? r(100 / (1 + targets[0].r_multiple), 2) : null,
    ...(warnings.length && { warnings }),
  };
}

export async function positionSize({ draw, atr_multiplier, _deps, ...params } = {}) {
  const getOhlcv = _deps?.getOhlcv || _getOhlcv;
  const drawShape = _deps?.drawShape || _drawShape;
  const p = { ...params };
  let atrInfo = null;

  if ((p.stop == null || p.entry == null) && (atr_multiplier || p.entry == null)) {
    const { bars } = await getOhlcv({ count: 100 });
    const atr = ta.last(ta.atr(bars, 14));
    const lastClose = bars[bars.length - 1].close;
    if (p.entry == null) p.entry = lastClose;
    if (p.stop == null) {
      if (!atr_multiplier) throw new Error('Provide stop, or atr_multiplier (+ side) to derive the stop from ATR');
      const dir = (p.side || 'long') === 'short' ? -1 : 1;
      p.stop = p.entry - dir * atr * Number(atr_multiplier);
    }
    atrInfo = { atr: r(atr), atr_multiplier: atr_multiplier ? Number(atr_multiplier) : null, last_close: lastClose };
  }
  if (p.stop == null) throw new Error('stop is required (or pass atr_multiplier)');

  const plan = calcPositionSize(p);
  const result = { success: true, ...plan, ...(atrInfo && { atr_source: atrInfo }) };

  if (draw) {
    const now = Math.floor(Date.now() / 1000);
    const lines = [
      { price: plan.entry, color: '#2962ff', label: `Entry ${plan.entry}` },
      { price: plan.stop, color: '#f23645', label: `Stop ${plan.stop}` },
      ...plan.targets.filter(t => t.valid).map((t, i) => ({ price: t.price, color: '#089981', label: `TP${i + 1} ${t.price} (${t.r_multiple}R)` })),
    ];
    const drawn = [];
    for (const l of lines) {
      try {
        const res = await drawShape({
          shape: 'horizontal_line', point: { time: now, price: l.price },
          overrides: { linecolor: l.color, linewidth: 2, showLabel: true, textcolor: l.color }, text: l.label,
        });
        drawn.push({ label: l.label, entity_id: res.entity_id });
      } catch (err) { drawn.push({ label: l.label, error: err.message }); }
    }
    result.drawings = drawn;
  }
  return result;
}
