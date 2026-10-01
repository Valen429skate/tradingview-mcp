---
name: tradingview-guide
description: How to drive the user's live TradingView chart with the tradingview MCP tools (109 tools) — which tool to use for analysis, precise entries, levels, risk, backtests, alerts, journal, Pine Script and chart control. Use whenever the user mentions TradingView, their chart, a symbol/ticker, trading, entries, levels, indicators, backtests or Pine Script.
---

# TradingView MCP — tool guide

The `tradingview` MCP server controls the user's TradingView Desktop over CDP (port 9222). Answer in the user's language. Never present output as financial advice.

## Not connected?
- `tv_health_check` → verify. If TradingView isn't running with the debug port: `tv_launch` (auto-detects and relaunches it).

## Analysis — start here
| User asks | Tool |
|---|---|
| "Analyze my chart", "should I buy/sell?" | `chart_analyze` (`include_mtf: true`, `account_size` for size) → verdict, score, reasons, plan, regime, precise entry |
| "Where exactly do I enter?" | `entry_zones` → confluence zone limit entry, stop, targets, R:R gate. `skip_poor_rr` / `no_setup` = say "wait" |
| "Trend or range?" | `market_regime` → state + playbook |
| Levels / S&R / pivots | `data_get_key_levels`; volume levels `data_volume_profile`; fib `data_fibonacci` |
| FVG, order blocks, liquidity | `data_smart_money` |
| Divergences | `data_divergences` |
| Candle patterns / structure | `data_detect_patterns` |
| Indicator values without adding them | `data_compute` (e.g. `["rsi:14","adx","supertrend","ema:200"]`) |
| Several timeframes | `chart_multi_timeframe` |
| Visual report | `report_generate` (returns an HTML file path) |

## Risk, alerts, journal
- `risk_position_size` (`point_value` for futures: ES=50, MES=5, NQ=20, MNQ=2; `draw: true` plots it)
- `alert_from_levels` with `dry_run: true` first, then without after the user confirms
- `journal_add` / `journal_update` / `journal_stats`

## Strategy testing
- `backtest_run` — rules like `entry: "ema_20 crosses_above ema_50 and adx > 20"`, `exit: "close crosses_below ema_20"`, `stop_atr`, `target_r`, `trail_atr`, `breakeven_r`
- ALWAYS follow a promising result with `backtest_validate` and report its verdict
- Pine strategies: `pine_set_source` → `pine_smart_compile` → `data_get_strategy_results` → `strategy_optimize`

## Screening
- `batch_scan` with `condition` (omit `symbols` to scan the open watchlist)

## Chart control
- `chart_set_symbol`, `chart_set_timeframe`, `chart_set_type`, `chart_manage_indicator` (FULL names: "Relative Strength Index"), `draw_shape`, `capture_screenshot`

## Context rules
- `data_get_ohlcv` always with `summary: true`
- Pine drawing tools (`data_get_pine_*`) always with `study_filter`
- Avoid `pine_get_source` on big scripts; call `chart_get_state` once
