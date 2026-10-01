---
name: strategy-lab
description: Iterate on a trading idea with the local backtester — turn a plain-language idea into entry/exit rules, test variants, compare against buy & hold, and hand the winner off to Pine Script. Use when the user asks "would X have worked", "test this strategy", or "find a better setup".
---

# Strategy Lab Workflow

## Step 1: Translate the Idea into Rules

Map the user's words to `backtest_run` rules:

| Idea | Rule |
|------|------|
| "buy golden cross" | entry `ema_50 crosses_above sma_200` |
| "buy pullbacks in an uptrend" | entry `close > ema_200 and rsi_14 crosses_above 40` |
| "breakout of 20-bar high" | entry `close > highest_20` |
| "mean reversion at lower band" | entry `close < bb_lower and rsi_14 < 30`, exit `close > bb_middle` |
| "MACD momentum" | entry `macd crosses_above macd_signal and macd < 0` |
| "volume spike breakout" | entry `close > highest_20 and volume > volume_sma_20` |

Always add risk: `stop_atr: 2` (or `stop_pct`) and a `target_r` or exit rule. Use `risk_percent: 1` so results are comparable.

## Step 2: Baseline, Then Vary One Thing at a Time

1. Run the baseline. Record net %, buy & hold %, trades, win rate, PF, max DD, avg R.
2. Change ONE parameter per run (stop distance, target R, a filter like `close > ema_200`).
3. Keep a small results table. Prefer robustness (several nearby settings all decent) over the single best number.

## Step 3: Sanity Checks

- < 20 trades → not significant; try a lower timeframe (`chart_set_timeframe`) or another symbol
- Compare to `buy_hold_pct` — a strategy that underperforms holding with more drawdown is not an edge
- Re-test the best rules on 2–3 other symbols (`chart_set_symbol`) — if it only works on one, it's curve-fit
- Commission: add `commission_pct: 0.05` (stocks/crypto) to see if the edge survives costs

## Step 4: Hand Off

- `report_generate` with the winning `backtest` spec → visual report for the user
- Optionally port to Pine: `pine_new` (strategy) → `pine_set_source` → `pine_smart_compile` → `data_get_strategy_results` to confirm on full history, then `strategy_optimize` for fine tuning

## Output Format

```
STRATEGY LAB — [SYMBOL] [TF], [N] bars
| # | Rules (change) | Trades | Win% | PF | Net% | B&H% | MaxDD% | Avg R |
|---|----------------|--------|------|----|------|------|--------|-------|
Verdict: [edge / no edge / inconclusive] — [why]
Next: [what to test next]
```

Results are in-sample and not financial advice.
