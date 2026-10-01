---
name: performance-review
description: Review the user's trading performance from the local trade journal — win rate, expectancy, R stats, best/worst setups, hours and recurring mistakes — and turn it into concrete rules. Use when the user asks "how am I doing", "review my trades", or "what am I doing wrong".
---

# Performance Review Workflow

## Step 1: Pull the Data

1. `journal_stats` — overall (add `from`/`to` for a period, e.g. last 30 days)
2. `journal_list` with `status: "open"` — open trades still unresolved
3. Optionally `journal_stats` with `setup` / `symbol` filters to drill down

If `closed_trades` < 20, say the sample is too small for firm conclusions.

## Step 2: Diagnose

- **Edge**: `expectancy` > 0 and `profit_factor` > 1.2 → positive edge. `avg_r` tells if winners are big enough.
- **Win rate vs payoff**: low win rate is fine if `payoff_ratio` is high; check `win_rate` > 100 / (1 + payoff_ratio).
- **Setups**: rank `by_setup` by pnl — which to keep, which to drop.
- **Timing**: `by_hour_utc` / `by_weekday_utc` — hours or days that lose consistently (convert to the user's timezone).
- **Discipline**: `by_mistake` — cost of each mistake in pnl. This is usually the biggest, easiest win.
- **Risk**: `max_drawdown`, `max_consecutive_losses` — is position size sustainable?

## Step 3: Output

```
PERFORMANCE — [period]
Trades: N (W/L/BE)   Win rate: x%   PF: x   Expectancy: $x / trade   Avg R: x
Net: $x   Max DD: $x   Max losing streak: n

Keep:   [best setups / hours]
Cut:    [worst setups / hours]
Fix:    [top mistakes and what they cost]
Rules for next period:
1. ...
2. ...
```

Optionally `data_export` with `type: "journal"` for a spreadsheet.
