---
name: precision-entry
description: Find a precise, professional entry on the current TradingView chart — regime, confluence zones (S/R, Fibonacci, volume profile, FVG, order blocks, VWAP, EMAs), limit entry, stop, targets, R:R filter and confirmation trigger. Use when the user asks "where do I enter", "best entry", "entrada precisa", "dónde entro", "sniper entry".
---

# Precision Entry Workflow

## Step 1: Regime and bias
1. `market_regime` → state + playbook. Trending: only trade WITH the trend (pullbacks). Ranging: fade the extremes. Squeeze: wait for the breakout.
2. `chart_analyze` (`include_mtf: true`) → verdict and score. If |score| < 15, tell the user there is no clear edge.

## Step 2: The zone
`entry_zones` (side from the verdict, or the user's choice). Read:
- `plan.entry_zone.sources` — WHY the zone matters (more independent families = stronger)
- `plan.action` — `buy_limit` / `sell_limit` = valid; `skip_poor_rr` / `no_setup` = recommend waiting and say at what price the trade would become valid
- `plan.targets` — with R multiples and what each target zone is

## Step 3: Confirm the details (optional, when the user wants depth)
- `data_smart_money` — is the zone an unfilled FVG / valid order block? Any recent liquidity sweep into it?
- `data_volume_profile` — is the zone at POC / VAL / VAH?
- `data_divergences` — does momentum agree?

## Step 4: Size and plot
- Ask for account size and risk % if unknown (default 1%, never suggest > 2%).
- `risk_position_size` with the plan's `entry`, `stop`, `targets`, `draw: true`.
- Offer `alert_from_levels` (dry run first) or `alert_create` at the zone so the user is notified when price arrives.

## Output
```
ENTRADA PRECISA — [SYMBOL] [TF]
Régimen:   [state] → [playbook in one line]
Sesgo:     [verdict] ([score]/100)
Zona:      [low]–[high] ★[score] — [sources]
Orden:     [buy/sell limit] en [entry] · Stop [stop] · TP1 [t1] ([R]R) · TP2 …
Tamaño:    [qty] ([risk] = [x]% de la cuenta)
Confirmar: [trigger]
Invalida:  [invalidation]
```
Not financial advice — the user decides.
