import { register } from '../router.js';
import * as core from '../../core/alerts.js';

register('alert', {
  description: 'Alert tools (list, create, delete, levels)',
  subcommands: new Map([
    ['list', {
      description: 'List active alerts',
      handler: () => core.list(),
    }],
    ['create', {
      description: 'Create a price alert',
      options: {
        price: { type: 'string', short: 'p', description: 'Price level' },
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, greater_than, less_than' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
      },
      handler: (opts) => core.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
      }),
    }],
    ['delete', {
      description: 'Delete alerts',
      options: {
        all: { type: 'boolean', description: 'Delete all alerts' },
        id: { type: 'string', description: 'Alert id to delete (from alert list)' },
      },
      handler: (opts) => core.deleteAlerts({ delete_all: opts.all, alert_id: opts.id ? Number(opts.id) : undefined }),
    }],
    ['levels', {
      description: 'Create alerts on nearest Pine/key levels',
      options: {
        source: { type: 'string', description: 'pine (default), key_levels, both' },
        filter: { type: 'string', short: 'f', description: 'Pine study name filter' },
        max: { type: 'string', short: 'm', description: 'Max alerts (default 5)' },
        distance: { type: 'string', description: 'Max distance % (default 5)' },
        'dry-run': { type: 'boolean', description: 'Preview only' },
      },
      handler: (opts) => core.createFromLevels({
        source: opts.source, study_filter: opts.filter,
        max_alerts: opts.max ? Number(opts.max) : undefined,
        max_distance_pct: opts.distance ? Number(opts.distance) : undefined,
        dry_run: opts['dry-run'],
      }),
    }],
  ]),
});
