---
name: multi-symbol-scan
description: Scan multiple symbols for setups, patterns, or strategy performance. Use when comparing across instruments or screening for opportunities.
---

# Multi-Symbol Scanner

You are scanning multiple symbols for trading setups or comparing performance.

## Step 1: Define the Scan

Determine:
- **Symbols**: Which instruments to scan (user-provided or watchlist via `watchlist_get`)
- **Timeframe**: Which timeframe to analyze
- **Criteria**: What to look for (indicator values, strategy results, visual patterns)

## Step 2: Run the Scan

### Fast path: screener (preferred)
`batch_scan` evaluates conditions on computed metrics for every symbol (or the open watchlist when `symbols` is omitted) and restores the chart:
```
symbols: ["AAPL", "MSFT", "NVDA", "AMZN"]
condition: "adx > 25 and supertrend_dir == 1 and rsi < 70"
sort_by: "-rel_volume"
```
Metrics include close, change_pct, rsi, atr_pct, ema20/50/200, sma*, bb_*, macd*, rel_volume, high_20/low_20, adx, plus_di, minus_di, supertrend_dir, stochrsi_k, chop, bb_width.
Then for the best 2–3 matches: `chart_set_symbol` → `chart_analyze` → `entry_zones`.


### For Strategy Performance Comparison
Use `batch_run` with action `get_strategy_results`:
```
symbols: ["ES1!", "NQ1!", "YM1!", "RTY1!"]
timeframes: ["15"]
action: "get_strategy_results"
```

### For Screenshot Comparison
Use `batch_run` with action `screenshot`:
```
symbols: ["AAPL", "MSFT", "GOOGL", "AMZN"]
timeframes: ["D"]
action: "screenshot"
```

### For Custom Analysis (per-symbol)
Loop through symbols manually:
1. `chart_set_symbol` + `chart_set_timeframe`
2. `chart_manage_indicator` — add the study
3. `data_get_ohlcv` — pull price data
4. `data_get_indicator` — read indicator values
5. Analyze and record findings

## Step 3: Compile Results

Build a comparison table:
| Symbol | Key Metric 1 | Key Metric 2 | Signal |
|--------|-------------|-------------|--------|

Sort by the most relevant metric.

## Step 4: Report

Present findings:
- Ranked list of symbols by the scan criteria
- Highlight the strongest setups
- Note any divergences or anomalies
- Screenshot the top 1-2 charts for visual confirmation

## Watchlist Integration

To scan the user's watchlist:
1. `watchlist_get` — read all symbols
2. Use the symbol list for the scan
3. `watchlist_add` — add new finds to the watchlist
