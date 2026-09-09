'use strict';

/**
 * Jobs API — unified view of pipeline execution history and current run status.
 *
 * GET /api/jobs          — summary of all pipelines with run status
 * GET /api/jobs/logs     — recent log entries across all pipelines (live feed)
 * GET /api/jobs/:id/logs — log entries for a specific pipeline
 */

const router = require('express').Router();
const { getDb } = require('../db');
const { requireAuth } = require('../auth');
const scheduler = require('../scheduler');

router.use(requireAuth);

// Summary: one row per pipeline with its current run state + stats
router.get('/', (req, res) => {
  const db = getDb();
  const runningIds = new Set(scheduler.runningIds());

  const rows = db.prepare(`
    SELECT
      p.id, p.name, p.description, p.status as pipeline_status,
      p.index_pattern, p.pull_mode,
      p.clickhouse_database, p.clickhouse_table,
      oc.name as connection_name,
      cc.name as cluster_name,
      ps.status as run_status,
      ps.last_run_at, ps.last_success_at, ps.last_error,
      ps.rows_inserted_total, ps.rows_inserted_today,
      ps.rows_dlq, ps.rows_failed,
      ps.cursor_timestamp, ps.checkpoint_committed_at,
      ps.last_batch_size
    FROM pipelines p
    LEFT JOIN opensearch_connections oc ON p.opensearch_connection_id = oc.id
    LEFT JOIN clickhouse_clusters cc ON p.clickhouse_cluster_id = cc.id
    LEFT JOIN pipeline_status ps ON p.id = ps.pipeline_id
    ORDER BY CASE WHEN p.status='active' THEN 0 ELSE 1 END, p.name
  `).all();

  const jobs = rows.map(r => ({
    ...r,
    is_running: runningIds.has(r.id),
    // Derive a single display status
    display_status: runningIds.has(r.id) ? 'running'
      : r.run_status === 'error' ? 'error'
      : r.pipeline_status === 'active' ? 'active'
      : 'paused',
  }));

  res.json(jobs);
});

// Live log feed — recent entries across all pipelines + system audit events, newest first
// Supports: limit, level, since, pipeline_id, before_id (cursor for "load older")
router.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '500'), 2000);
  const level      = req.query.level;
  const since      = req.query.since;
  const beforeId   = req.query.before_id ? parseInt(req.query.before_id) : null;
  const pipelineId = req.query.pipeline_id;
  const search     = req.query.search;

  let sql = `
    SELECT l.id, l.pipeline_id, COALESCE(p.name, '[system]') as pipeline_name, l.level, l.message, l.created_at
    FROM pipeline_logs l
    LEFT JOIN pipelines p ON p.id = l.pipeline_id
    WHERE 1=1
  `;
  const params = [];

  if (level)      { sql += ' AND l.level = ?';            params.push(level); }
  if (since)      { sql += ' AND l.created_at > ?';       params.push(since); }
  if (beforeId)   { sql += ' AND l.id < ?';               params.push(beforeId); }
  if (search)     { sql += ' AND l.message LIKE ?';       params.push(`%${search}%`); }
  if (pipelineId) { sql += ' AND (l.pipeline_id = ? OR l.pipeline_id IS NULL)'; params.push(pipelineId); }

  sql += ' ORDER BY l.id DESC LIMIT ?';
  params.push(limit);

  const rows = getDb().prepare(sql).all(...params);
  res.json(rows.reverse()); // return chronological order
});

// Log history — paginated, searchable, for the dedicated logs page
router.get('/log-history', (req, res) => {
  const page       = Math.max(1, parseInt(req.query.page || '1'));
  const limit      = Math.min(parseInt(req.query.limit || '200'), 1000);
  const offset     = (page - 1) * limit;
  const level      = req.query.level;
  const pipelineId = req.query.pipeline_id;
  const search     = req.query.search;
  const dateFrom   = req.query.date_from;
  const dateTo     = req.query.date_to;

  let where = 'WHERE 1=1';
  const params = [];

  if (level)      { where += ' AND l.level = ?';            params.push(level); }
  if (pipelineId) { where += ' AND l.pipeline_id = ?';      params.push(pipelineId); }
  if (search)     { where += ' AND l.message LIKE ?';       params.push(`%${search}%`); }
  if (dateFrom)   { where += ' AND l.created_at >= ?';      params.push(dateFrom); }
  if (dateTo)     { where += ' AND l.created_at <= ?';      params.push(dateTo + 'T23:59:59'); }

  const db = getDb();
  const countRow = db.prepare(`SELECT COUNT(*) as total FROM pipeline_logs l ${where}`).get(...params);
  const total = countRow.total;

  const rows = db.prepare(`
    SELECT l.id, l.pipeline_id, COALESCE(p.name, '[system]') as pipeline_name, l.level, l.message, l.created_at
    FROM pipeline_logs l
    LEFT JOIN pipelines p ON p.id = l.pipeline_id
    ${where}
    ORDER BY l.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ rows, total, page, limit, pages: Math.ceil(total / limit) });
});

// Per-pipeline log history
router.get('/:id/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 1000);
  const rows = getDb().prepare(
    `SELECT id, level, message, created_at
     FROM pipeline_logs WHERE pipeline_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(req.params.id, limit);
  res.json(rows.reverse());
});

module.exports = router;
