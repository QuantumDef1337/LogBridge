'use strict';

/**
 * Shared audit logger — writes to pipeline_logs with pipeline_id=NULL for system events.
 * System events appear in the global Live Log Feed alongside pipeline run logs.
 */

const { getDb } = require('./db');

const CATEGORIES = {
  pipeline:   'pipeline',
  connection: 'connection',
  cluster:    'cluster',
  system:     'system',
};

function log(level, category, message, pipelineId = null) {
  try {
    getDb()
      .prepare("INSERT INTO pipeline_logs (pipeline_id, level, message) VALUES (?, ?, ?)")
      .run(pipelineId || null, level, `[${category}] ${message}`);
  } catch {
    // Never let audit logging crash a route handler
  }
}

module.exports = {
  info:  (category, msg, pid) => log('info',  category, msg, pid),
  warn:  (category, msg, pid) => log('warn',  category, msg, pid),
  error: (category, msg, pid) => log('error', category, msg, pid),
  CATEGORIES,
};
