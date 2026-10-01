import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert on the current chart symbol via TradingView\'s alert API', {
    condition: z.string().describe('Alert condition: "crossing", "greater_than", or "less_than"'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete a specific alert by id, or all active alerts', {
    alert_id: z.coerce.number().optional().describe('Alert id to delete (from alert_list)'),
    delete_all: z.coerce.boolean().optional().describe('Delete all active alerts'),
  }, async ({ alert_id, delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ alert_id, delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_from_levels', 'Create crossing alerts on the price levels closest to the current price — from Pine indicator lines (line.new) and/or auto-detected key levels (S/R, pivots, previous day H/L). Use dry_run=true to preview first.', {
    source: z.enum(['pine', 'key_levels', 'both']).optional().describe('Where levels come from (default pine)'),
    study_filter: z.string().optional().describe('For source=pine: indicator name substring'),
    max_alerts: z.coerce.number().optional().describe('Max alerts to create (default 5, max 20)'),
    max_distance_pct: z.coerce.number().optional().describe('Only levels within this % of price (default 5)'),
    message_prefix: z.string().optional().describe('Prefix for alert messages'),
    dry_run: z.coerce.boolean().optional().describe('Preview the levels without creating alerts'),
  }, async (args) => {
    try { return jsonResult(await core.createFromLevels(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
