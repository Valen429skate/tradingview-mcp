---
name: trade-plan
description: Build a complete trade plan — multi-timeframe bias, key levels, position size, drawn entry/stop/targets, alerts, and a journal entry. Use when the user asks "should I take this trade", "plan a trade", "how many contracts", or wants a structured setup.
---

# Trade Plan Workflow

You are helping the user build a disciplined, risk-defined trade plan. You never place real orders — you prepare the plan; the user decides and executes.

## Step 1: Context

1. `chart_get_state` — symbol and timeframe
2. `chart_multi_timeframe` (default W, D, 240, 60) — read `alignment.bias`
   - `bullish_aligned` / `bearish_aligned` → trend trades favored
   - `mixed` → prefer range trades or smaller size, and say so

## Step 2: Levels

1. `data_get_key_levels` — nearest support/resistance, pivots, previous day H/L
2. If the user has custom level indicators: `data_get_pine_lines` with `study_filter`
3. Pick a logical entry and a stop **beyond** a level (not at it). If no obvious level, use an ATR stop (`atr_multiplier: 1.5`).

## Step 3: Size the Position

`risk_position_size` with:
- `account_size` and `risk_percent` (ask the user if unknown — default 1%, never suggest more than 2%)
- `entry`, `stop` (or `atr_multiplier` + `side`)
- `point_value` for futures (ES=50, MES=5, NQ=20, MNQ=2, CL=1000, GC=100), `qty_step` for crypto/forex
- `targets` at the next key levels, or `rr_targets: [1, 2, 3]`

Check `warnings`. If the first target is < 1R, tell the user the trade has poor reward/risk.

## Step 4: Visualize & Alert

1. Call `risk_position_size` again with `draw: true` to plot entry/stop/targets (or draw only after the user confirms)
2. `alert_from_levels` with `source: "key_levels"` and `dry_run: true` → show, then create on confirmation
3. `capture_screenshot` with `region: "chart"`

## Step 5: Journal

When the user takes the trade: `journal_add` with symbol, side, entry, stop, quantity, point_value, setup, and the screenshot path. When they exit: `journal_update` with `id` and `exit`.

## Output Format

```
TRADE PLAN — [SYMBOL] [TF]
Bias:     [alignment] (W: x, D: x, 4H: x, 1H: x)
Setup:    [long/short] at [entry], stop [stop] ([distance], [x]% / [ATR multiple])
Size:     [qty] units — risk $[actual_risk] ([x]% of account)
Targets:  TP1 [price] ([R]R)  TP2 ...  
Levels:   S [..] | R [..]
Invalidation: [what would make this setup wrong]
Breakeven win rate at TP1: [x]%
```

Always remind the user this is analysis, not financial advice.
