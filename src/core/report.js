/**
 * Self-contained HTML chart report: candlesticks with EMAs, support /
 * resistance, candle patterns and backtest trades, plus the confluence verdict,
 * suggested plan, backtest stats and equity curve. One file, no external
 * assets — open it in any browser, attach it, or archive it with a journal entry.
 *
 * buildReportHtml() is pure (data in, HTML string out); generateReport()
 * gathers data from the chart and writes reports/<name>.html.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as ta from './ta.js';
import { computeKeyLevels } from './analysis.js';
import { detectCandles, marketStructure } from './patterns.js';
import { scoreConfluence, buildPlan } from './insight.js';
import { runBacktest } from './backtest.js';
import { sanitizeFilename } from './export.js';
import { getOhlcv as _getOhlcv } from './data.js';
import { getState as _getState } from './chart.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPORT_DIR = join(dirname(dirname(__dirname)), 'reports');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: Math.min(dp, 2) }));
const pdp = (price) => (price >= 1000 ? 2 : price >= 1 ? 2 : price >= 0.01 ? 4 : 8);
const dateStr = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);

const VERDICT_LABEL = {
  strong_bullish: ['▲▲', 'Strong bullish'], bullish: ['▲', 'Bullish'], neutral: ['◆', 'Neutral'],
  bearish: ['▼', 'Bearish'], strong_bearish: ['▼▼', 'Strong bearish'],
};

// ── SVG builders ───────────────────────────────────────────────────────────

function priceChart({ bars, ema20, ema50, support, resistance, patterns, trades }) {
  const W = 960, H = 420, padL = 8, padR = 72, padT = 14, padB = 26;
  const n = bars.length;
  const levelPrices = [...support, ...resistance].map(z => z.price);
  let lo = Math.min(...bars.map(b => b.low)), hi = Math.max(...bars.map(b => b.high));
  // Include levels that are reasonably close so they're visible, without crushing the candles.
  const span = hi - lo;
  for (const p of levelPrices) if (p > lo - span * 0.15 && p < hi + span * 0.15) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
  const pad = (hi - lo) * 0.04 || 1;
  lo -= pad; hi += pad;
  const x = (i) => padL + ((i + 0.5) / n) * (W - padL - padR);
  const y = (p) => padT + ((hi - p) / (hi - lo)) * (H - padT - padB);
  const cw = Math.max(1.5, ((W - padL - padR) / n) * 0.62);
  const dp = pdp(bars.at(-1).close);
  const out = [];

  // Right-edge EMA labels: place first (nudged apart) so price ticks can yield to them.
  const emaLabels = [[ema20, 'EMA 20'], [ema50, 'EMA 50']]
    .map(([s, label]) => ({ label, y: ta.last(s) != null ? y(ta.last(s)) : null }))
    .filter(l => l.y != null)
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < emaLabels.length; k++) if (emaLabels[k].y - emaLabels[k - 1].y < 13) emaLabels[k].y = emaLabels[k - 1].y + 13;

  // Grid + price axis (recessive)
  for (let k = 0; k <= 5; k++) {
    const p = lo + ((hi - lo) * k) / 5;
    out.push(`<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(p)}" y2="${y(p)}"/>`);
    if (!emaLabels.some(l => Math.abs(l.y - y(p)) < 13)) out.push(`<text class="tick" x="${W - padR + 6}" y="${y(p) + 4}">${fmt(p, dp)}</text>`);
  }
  // Time ticks
  for (let k = 0; k < 5; k++) {
    const i = Math.round((k * (n - 1)) / 4);
    out.push(`<text class="tick" text-anchor="${k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}" x="${x(i)}" y="${H - 8}">${dateStr(bars[i].time).slice(0, 10)}</text>`);
  }
  // Support / resistance — hairline dashed, labelled (identity by text, not color)
  for (const [zones, tag] of [[support, 'S'], [resistance, 'R']]) {
    for (const z of zones) {
      if (z.price < lo || z.price > hi) continue;
      out.push(`<line class="level" x1="${padL}" x2="${W - padR}" y1="${y(z.price)}" y2="${y(z.price)}"><title>${tag} ${fmt(z.price, dp)} · ${z.touches} touches</title></line>`);
      out.push(`<text class="level-label" x="${W - padR - 4}" y="${y(z.price) - 4}" text-anchor="end">${tag} ${fmt(z.price, dp)}${z.touches > 1 ? ` ×${z.touches}` : ''}</text>`);
    }
  }
  // Candles — up = blue, down = red (validated pair), 2px surface gap via width
  bars.forEach((b, i) => {
    const up = b.close >= b.open;
    const top = y(Math.max(b.open, b.close)), bot = y(Math.min(b.open, b.close));
    out.push(`<g class="${up ? 'up' : 'down'}"><line class="wick" x1="${x(i)}" x2="${x(i)}" y1="${y(b.high)}" y2="${y(b.low)}"/><rect x="${x(i) - cw / 2}" y="${top}" width="${cw}" height="${Math.max(1, bot - top)}" rx="${Math.min(2, cw / 4)}"/></g>`);
  });
  // EMAs — ink, solid vs dashed, direct-labelled
  const path = (s) => s.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' L');
  for (const [s, cls] of [[ema20, 'ema20'], [ema50, 'ema50']]) {
    const d = path(s);
    if (d) out.push(`<path class="${cls}" d="M${d}"/>`);
  }
  for (const l of emaLabels) out.push(`<text class="ema-label" x="${W - padR + 6}" y="${l.y + 4}">${l.label}</text>`);
  // Pattern markers
  const t2i = new Map(bars.map((b, i) => [b.time, i]));
  for (const p of patterns) {
    const i = t2i.get(p.time);
    if (i == null) continue;
    const bull = p.bias === 'bullish', bear = p.bias === 'bearish';
    const py = bear ? y(bars[i].high) - 10 : y(bars[i].low) + 16;
    out.push(`<text class="pattern" x="${x(i)}" y="${py}" text-anchor="middle">${bull ? '▲' : bear ? '▼' : '◆'}<title>${esc(p.pattern.replace(/_/g, ' '))} (${p.bias})</title></text>`);
  }
  // Backtest trades: entry ring, exit cross, connecting hairline
  for (const t of trades) {
    const i1 = t2i.get(t.entry_time), i2 = t2i.get(t.exit_time);
    if (i1 == null || i2 == null) continue;
    const win = t.pnl > 0;
    out.push(`<line class="trade-link ${win ? 'win' : 'loss'}" x1="${x(i1)}" y1="${y(t.entry)}" x2="${x(i2)}" y2="${y(t.exit)}"/>`);
    out.push(`<circle class="trade-entry" cx="${x(i1)}" cy="${y(t.entry)}" r="4.5"><title>Entry ${fmt(t.entry, dp)}</title></circle>`);
    out.push(`<text class="trade-exit" x="${x(i2)}" y="${y(t.exit) + 4}" text-anchor="middle">✕<title>Exit ${fmt(t.exit, dp)} · ${t.exit_reason} · ${fmt(t.pnl)}</title></text>`);
  }
  // Hover layer
  out.push(`<line id="xh" class="crosshair" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden"/>`);
  out.push(`<rect id="hit" x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" fill="transparent"/>`);
  return { svg: `<svg id="price" viewBox="0 0 ${W} ${H}" role="img" aria-label="Candlestick chart with EMA 20, EMA 50 and support/resistance levels">${out.join('')}</svg>`, geom: { W, padL, padR, n } };
}

function equityChart(curve, initial) {
  if (!curve?.length) return '';
  const W = 960, H = 180, padL = 8, padR = 72, padT = 12, padB = 22;
  const vals = curve.map(p => p.equity);
  let lo = Math.min(...vals, initial), hi = Math.max(...vals, initial);
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const x = (i) => padL + (i / Math.max(1, curve.length - 1)) * (W - padL - padR);
  const y = (v) => padT + ((hi - v) / (hi - lo)) * (H - padT - padB);
  const d = curve.map((p, i) => `${x(i)},${y(p.equity)}`).join(' L');
  const out = [];
  for (let k = 0; k <= 3; k++) {
    const v = lo + ((hi - lo) * k) / 3;
    out.push(`<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${W - padR + 6}" y="${y(v) + 4}">${fmt(v, 0)}</text>`);
  }
  out.push(`<line class="baseline" x1="${padL}" x2="${W - padR}" y1="${y(initial)}" y2="${y(initial)}"/>`);
  out.push(`<text class="tick" x="${padL + 4}" y="${y(initial) - 5}">Start ${fmt(initial, 0)}</text>`);
  out.push(`<path class="equity-area" d="M${x(0)},${y(initial)} L${d} L${x(curve.length - 1)},${y(initial)} Z"/>`);
  out.push(`<path class="equity" d="M${d}"/>`);
  out.push(`<circle class="equity-end" cx="${x(curve.length - 1)}" cy="${y(vals.at(-1))}" r="4"/>`);
  out.push(`<line id="exh" class="crosshair" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden"/><rect id="ehit" x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" fill="transparent"/>`);
  return `<svg id="equity" viewBox="0 0 ${W} ${H}" role="img" aria-label="Backtest equity curve">${out.join('')}</svg>`;
}

// ── Page ───────────────────────────────────────────────────────────────────

const CSS = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);--up:#2a78d6;--down:#e34948;--good:#006300;--bad:#d03b3b;--accent:#2a78d6}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--up:#3987e5;--down:#e66767;--good:#0ca30c;--bad:#e66767;--accent:#3987e5}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--up:#3987e5;--down:#e66767;--good:#0ca30c;--bad:#e66767;--accent:#3987e5}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;margin-bottom:16px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:0 0 10px}.sub{color:var(--ink2)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.tile .k{color:var(--ink2);font-size:12px}.tile .v{font-size:22px;font-weight:600}
.verdict .v{display:flex;gap:8px;align-items:center}.pos{color:var(--good)}.neg{color:var(--bad)}
.meter{height:8px;border-radius:4px;background:var(--grid);position:relative;margin-top:8px}
.meter i{position:absolute;top:-3px;width:3px;height:14px;border-radius:2px;background:var(--ink)}
.meter .mid{position:absolute;left:50%;top:0;width:1px;height:8px;background:var(--axis)}
svg{width:100%;height:auto;display:block}
.grid{stroke:var(--grid);stroke-width:1}.baseline{stroke:var(--axis);stroke-width:1;stroke-dasharray:3 3}
.tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.up rect{fill:var(--up)}.down rect{fill:var(--down)}.up .wick{stroke:var(--up)}.down .wick{stroke:var(--down)}.wick{stroke-width:1}
.ema20{fill:none;stroke:var(--ink2);stroke-width:2}.ema50{fill:none;stroke:var(--ink2);stroke-width:2;stroke-dasharray:6 4}
.ema-label{fill:var(--ink2);font-size:11px;font-weight:600}
.level{stroke:var(--muted);stroke-width:1;stroke-dasharray:2 4}.level-label{fill:var(--muted);font-size:11px;paint-order:stroke;stroke:var(--surface);stroke-width:3px}
.pattern{fill:var(--ink);font-size:11px}
.trade-link{stroke-width:1.5;stroke-dasharray:3 2}.trade-link.win{stroke:var(--good)}.trade-link.loss{stroke:var(--bad)}
.trade-entry{fill:var(--surface);stroke:var(--ink);stroke-width:2}.trade-exit{fill:var(--ink);font-size:12px;font-weight:700}
.equity{fill:none;stroke:var(--accent);stroke-width:2}.equity-area{fill:var(--accent);opacity:.10}.equity-end{fill:var(--accent);stroke:var(--surface);stroke-width:2}
.crosshair{stroke:var(--muted);stroke-width:1}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;color:var(--ink2);font-size:12px;margin:0 0 8px}
.legend span{display:inline-flex;align-items:center;gap:6px}.sw{width:10px;height:10px;border-radius:2px;display:inline-block}
.ln{width:18px;height:0;border-top:2px solid var(--ink2);display:inline-block}.ln.d{border-top-style:dashed}
.chart-wrap{position:relative;overflow-x:auto}.chart-wrap svg{min-width:640px}
.tip{position:absolute;pointer-events:none;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);white-space:nowrap;display:none;z-index:2}
.tip b{font-weight:600}.tip .r{display:flex;justify-content:space-between;gap:12px;font-variant-numeric:tabular-nums}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:720px){.cols{grid-template-columns:1fr}}
ul.f{margin:0;padding:0;list-style:none}ul.f li{display:flex;gap:10px;padding:6px 0;border-top:1px solid var(--grid)}ul.f li:first-child{border-top:0}
ul.f .p{font-variant-numeric:tabular-nums;font-weight:600;min-width:34px;text-align:right}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:6px 8px;text-align:right;border-top:1px solid var(--grid);font-variant-numeric:tabular-nums;white-space:nowrap}
th{color:var(--ink2);font-weight:500;border-top:0}th:first-child,td:first-child{text-align:left}
.tbl{overflow-x:auto}details summary{cursor:pointer;color:var(--ink2);margin-top:8px}
.plan dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:0}.plan dt{color:var(--ink2)}.plan dd{margin:0;font-variant-numeric:tabular-nums}
footer{color:var(--muted);font-size:12px;margin-top:24px}
`;

const JS = `
(function(){
  var D = JSON.parse(document.getElementById('report-data').textContent);
  function wire(svgId, hitId, xhId, n, render){
    var svg=document.getElementById(svgId), hit=document.getElementById(hitId), xh=document.getElementById(xhId), tip=document.getElementById(svgId+'-tip');
    if(!svg||!hit) return;
    var vb=svg.viewBox.baseVal, x0=+hit.getAttribute('x'), w=+hit.getAttribute('width');
    function move(e){
      var r=svg.getBoundingClientRect(), sx=(e.clientX-r.left)*vb.width/r.width;
      var i=Math.max(0,Math.min(n-1,Math.round(((sx-x0)/w)*n-0.5)));
      if(svgId==='equity') i=Math.max(0,Math.min(n-1,Math.round(((sx-x0)/w)*(n-1))));
      var cx = svgId==='equity' ? x0+(i/Math.max(1,n-1))*w : x0+((i+0.5)/n)*w;
      xh.setAttribute('x1',cx);xh.setAttribute('x2',cx);xh.setAttribute('visibility','visible');
      tip.innerHTML=render(i);tip.style.display='block';
      var px=cx*r.width/vb.width, wrap=svg.parentNode.getBoundingClientRect();
      var left=px+14; if(left+tip.offsetWidth>wrap.width) left=px-14-tip.offsetWidth;
      tip.style.left=Math.max(0,left)+'px'; tip.style.top='8px';
    }
    function out(){xh.setAttribute('visibility','hidden');tip.style.display='none';}
    hit.addEventListener('pointermove',move);hit.addEventListener('pointerleave',out);
  }
  function row(k,v){return '<div class="r"><span>'+k+'</span><b>'+v+'</b></div>';}
  function f(v){return v==null?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:D.dp});}
  wire('price','hit','xh',D.bars.length,function(i){
    var b=D.bars[i], up=b.c>=b.o, ch=((b.c-b.o)/b.o*100).toFixed(2);
    return '<div><b>'+b.d+'</b> · '+(up?'▲ up':'▼ down')+' '+ch+'%</div>'+row('Open',f(b.o))+row('High',f(b.h))+row('Low',f(b.l))+row('Close',f(b.c))+
      (D.ema20[i]!=null?row('EMA 20',f(D.ema20[i])):'')+(D.ema50[i]!=null?row('EMA 50',f(D.ema50[i])):'')+(D.pat[b.t]?'<div>'+D.pat[b.t]+'</div>':'');
  });
  if(D.equity) wire('equity','ehit','exh',D.equity.length,function(i){var p=D.equity[i];return '<div><b>'+p.d+'</b></div>'+row('Equity',Number(p.e).toLocaleString('en-US',{maximumFractionDigits:0}));});
})();
`;

export function buildReportHtml({ symbol, timeframe, bars, analysis, levels, patterns, backtest, generated_at, max_bars = 150 }) {
  const shown = bars.slice(-max_bars);
  const closes = bars.map(b => b.close);
  const ema20 = ta.ema(closes, 20).slice(-shown.length);
  const ema50 = ta.ema(closes, 50).slice(-shown.length);
  const startT = shown[0].time;
  const trades = (backtest?.trades || []).filter(t => t.entry_time >= startT);
  const pats = (patterns || []).filter(p => p.time >= startT && p.bias !== 'neutral');
  const { svg } = priceChart({ bars: shown, ema20, ema50, support: levels.support.slice(0, 4), resistance: levels.resistance.slice(0, 4), patterns: pats, trades });
  const dp = pdp(shown.at(-1).close);
  const last = shown.at(-1), prev = shown.at(-2) || last;
  const chg = ((last.close - prev.close) / prev.close) * 100;
  const [vIcon, vLabel] = VERDICT_LABEL[analysis.verdict] || ['◆', analysis.verdict];
  const scorePos = 50 + analysis.score / 2;
  const s = backtest?.stats;

  const factorList = (arr) => (arr.length ? `<ul class="f">${arr.map(fx => `<li><span class="p ${fx.points > 0 ? 'pos' : 'neg'}">${fx.points > 0 ? '+' : ''}${fx.points}</span><span>${esc(fx.reason)}</span></li>`).join('')}</ul>` : '<p class="sub">None</p>');
  const plan = analysis.plan;
  const planHtml = plan.action === 'wait'
    ? `<p>${esc(plan.reason)}</p><dl><dt>Breakout above</dt><dd>${fmt(plan.watch.breakout_above, dp)}</dd><dt>Breakdown below</dt><dd>${fmt(plan.watch.breakdown_below, dp)}</dd></dl>`
    : `<dl><dt>Bias</dt><dd>${plan.action === 'look_for_long' ? '▲ Look for long' : '▼ Look for short'}</dd><dt>Entry</dt><dd>${fmt(plan.entry, dp)}</dd><dt>Stop</dt><dd>${fmt(plan.stop, dp)} <span class="sub">(${esc(plan.stop_basis)})</span></dd>${plan.targets.map((t, i) => `<dt>Target ${i + 1}</dt><dd>${fmt(t.price, dp)} <span class="sub">(${t.r_multiple}R)</span></dd>`).join('')}<dt>Invalidation</dt><dd>${esc(plan.invalidation)}</dd>${plan.position ? `<dt>Size</dt><dd>${plan.position.quantity} units · risk ${fmt(plan.position.actual_risk)} (${plan.position.actual_risk_pct}%)</dd>` : ''}</dl>`;

  const btHtml = backtest ? `
  <section class="card"><h2>Backtest — <span class="sub">${esc(backtest.rules.entry)}${backtest.rules.exit ? ` → exit: ${esc(backtest.rules.exit)}` : ''}</span></h2>
    <div class="tiles">
      <div class="tile"><div class="k">Net profit</div><div class="v ${s.net_profit_pct >= 0 ? 'pos' : 'neg'}">${s.net_profit_pct >= 0 ? '+' : ''}${fmt(s.net_profit_pct)}%</div><div class="sub">vs buy &amp; hold ${s.buy_hold_pct >= 0 ? '+' : ''}${fmt(s.buy_hold_pct)}%</div></div>
      <div class="tile"><div class="k">Trades · win rate</div><div class="v">${s.total_trades} · ${fmt(s.win_rate, 1)}%</div></div>
      <div class="tile"><div class="k">Profit factor</div><div class="v">${fmt(s.profit_factor)}</div></div>
      <div class="tile"><div class="k">Max drawdown</div><div class="v neg">−${fmt(s.max_drawdown_pct)}%</div></div>
      <div class="tile"><div class="k">Avg R</div><div class="v">${fmt(s.avg_r)}</div></div>
    </div>
    <div class="chart-wrap">${equityChart(backtest.curve, s.initial_capital)}<div class="tip" id="equity-tip"></div></div>
    <details><summary>Trades table (${backtest.trades.length})</summary><div class="tbl"><table><thead><tr><th>Entry time</th><th>Side</th><th>Entry</th><th>Exit</th><th>Reason</th><th>Bars</th><th>R</th><th>P&amp;L</th></tr></thead><tbody>
    ${backtest.trades.slice(-50).reverse().map(t => `<tr><td>${dateStr(t.entry_time)}</td><td>${t.side}</td><td>${fmt(t.entry, dp)}</td><td>${fmt(t.exit, dp)}</td><td>${t.exit_reason}</td><td>${t.bars_held}</td><td>${t.r_multiple ?? '—'}</td><td class="${t.pnl >= 0 ? 'pos' : 'neg'}">${fmt(t.pnl)}</td></tr>`).join('')}
    </tbody></table></div></details>
  </section>` : '';

  const data = {
    dp,
    bars: shown.map(b => ({ t: b.time, d: dateStr(b.time), o: b.open, h: b.high, l: b.low, c: b.close })),
    ema20: ema20.map(v => ta.round(v, 8)), ema50: ema50.map(v => ta.round(v, 8)),
    pat: Object.fromEntries(pats.map(p => [p.time, `${p.bias === 'bullish' ? '▲' : p.bias === 'bearish' ? '▼' : '◆'} ${p.pattern.replace(/_/g, ' ')}`])),
    equity: backtest?.curve ? backtest.curve.map(p => ({ d: dateStr(p.time), e: p.equity })) : null,
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(symbol)} Chart Report</title><style>${CSS}</style></head>
<body><main>
<header><h1>${esc(symbol)} <span class="sub">· ${esc(timeframe)}</span></h1><span class="sub">${fmt(last.close, dp)} <span class="${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '▲ +' : '▼ '}${fmt(chg)}%</span> · ${esc(dateStr(last.time))} UTC</span></header>

<div class="tiles">
  <div class="tile verdict"><div class="k">Confluence verdict</div><div class="v">${vIcon} ${esc(vLabel)}</div><div class="meter" role="img" aria-label="Score ${analysis.score} of -100 to 100"><span class="mid"></span><i style="left:calc(${scorePos}% - 1.5px)"></i></div><div class="sub">Score ${analysis.score > 0 ? '+' : ''}${analysis.score} / 100</div></div>
  <div class="tile"><div class="k">Trend (EMA stack)</div><div class="v">${esc(String(analysis.snapshot.trend).replace('_', ' '))}</div><div class="sub">Structure: ${esc(analysis.structure.structure)}</div></div>
  <div class="tile"><div class="k">RSI 14</div><div class="v">${fmt(analysis.snapshot.rsi, 1)}</div></div>
  <div class="tile"><div class="k">ATR 14</div><div class="v">${fmt(analysis.snapshot.atr, dp)}</div><div class="sub">${fmt(analysis.snapshot.atr_pct)}% of price</div></div>
  <div class="tile"><div class="k">Support · Resistance</div><div class="v" style="font-size:17px">${fmt(levels.nearest_support, dp)} · ${fmt(levels.nearest_resistance, dp)}</div></div>
</div>

<section class="card"><h2>Price — last ${shown.length} bars</h2>
  <div class="legend"><span><i class="sw" style="background:var(--up)"></i>Up candle</span><span><i class="sw" style="background:var(--down)"></i>Down candle</span><span><i class="ln"></i>EMA 20</span><span><i class="ln d"></i>EMA 50</span><span>┄ S / R level</span><span>▲▼ Candle pattern</span>${trades.length ? '<span>○ Entry · ✕ Exit</span>' : ''}</div>
  <div class="chart-wrap">${svg}<div class="tip" id="price-tip"></div></div>
</section>

<div class="cols">
  <section class="card"><h2>Why — bullish factors</h2>${factorList(analysis.bullish_factors)}</section>
  <section class="card"><h2>Why — bearish factors</h2>${factorList(analysis.bearish_factors)}</section>
</div>
<section class="card plan"><h2>Suggested plan</h2>${planHtml}</section>
${btHtml}
<footer>Generated ${esc(generated_at)} by tradingview-mcp · Rule-based technical analysis, not financial advice. Backtests fill at next-bar open and are in-sample.</footer>
</main>
<script type="application/json" id="report-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>${JS}</script>
</body></html>`;
}

/** Gather everything from the chart and write reports/<name>.html. */
export async function generateReport({ count, backtest: btOpts, account_size, risk_percent, point_value, filename, _deps } = {}) {
  const getOhlcv = _deps?.getOhlcv || _getOhlcv;
  const getState = _deps?.getState || _getState;
  const write = _deps?.writeFile || ((p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); });

  const { bars } = await getOhlcv({ count: Math.min(count || 500, 500) });
  if (!bars || bars.length < 60) throw new Error('Need at least 60 bars for a report');
  let symbol = 'Chart', timeframe = '';
  try { const st = await getState(); symbol = st.symbol || symbol; timeframe = st.resolution || ''; } catch { /* offline */ }

  const snap = ta.snapshot(bars);
  const levels = computeKeyLevels(bars);
  const structure = marketStructure(bars);
  const patterns = detectCandles(bars, { lookback: 150 });
  const conf = scoreConfluence({ snap, structure, patterns: patterns.filter(p => p.bars_ago <= 10), levels });
  const plan = buildPlan({ verdict: conf.verdict, snap, levels }, { account_size, risk_percent, point_value });
  const analysis = { ...conf, plan, snapshot: snap, structure };

  let backtest = null;
  if (btOpts) {
    const opts = typeof btOpts === 'string' ? JSON.parse(btOpts) : btOpts;
    const res = runBacktest(bars, opts);
    backtest = { rules: { entry: opts.entry, exit: opts.exit }, stats: res.stats, trades: res.trades, curve: res.curve };
  }

  const html = buildReportHtml({ symbol, timeframe, bars, analysis, levels, patterns, backtest, generated_at: new Date().toISOString() });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = sanitizeFilename(filename || `report_${symbol}_${timeframe}_${ts}`);
  const file = join(REPORT_DIR, base.endsWith('.html') ? base : `${base}.html`);
  write(file, html);
  return {
    success: true, file_path: file, bytes: Buffer.byteLength(html),
    verdict: conf.verdict, score: conf.score,
    ...(backtest && { backtest_summary: { trades: backtest.stats.total_trades, net_profit_pct: backtest.stats.net_profit_pct, win_rate: backtest.stats.win_rate, max_drawdown_pct: backtest.stats.max_drawdown_pct } }),
    note: 'Open the file in a browser. It is fully self-contained (no internet needed).',
  };
}
