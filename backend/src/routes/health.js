const router = require('express').Router();
const { getDb } = require('../db');
const metrics = require('../services/metrics');

// ── /api/health ─────────────────────────────────────────────────────────────
// Liveness probe: answers 200 as long as the process is alive and the DB is open.
router.get('/health', (req, res) => {
  try {
    // A trivial DB query to confirm the connection is alive
    getDb().prepare('SELECT 1').get();
    res.json({
      ok: true,
      status: 'alive',
      version: '1.0.0',
      uptime_secs: metrics.getUptimeSeconds(),
      started_at: new Date(metrics.startedAt).toISOString(),
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(503).json({ ok: false, status: 'db_error', error: e.message });
  }
});

// ── /api/ready ──────────────────────────────────────────────────────────────
// Readiness probe: confirms the DB is queryable and at least one pipeline exists.
// Kubernetes / load-balancers can use this to gate traffic.
router.get('/ready', (req, res) => {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    const pipelineCount = db.prepare('SELECT COUNT(*) as c FROM pipelines').get().c;
    const connectionCount = db.prepare('SELECT COUNT(*) as c FROM opensearch_connections').get().c;
    const clusterCount = db.prepare('SELECT COUNT(*) as c FROM clickhouse_clusters').get().c;

    res.json({
      ok: true,
      status: 'ready',
      pipelines: pipelineCount,
      opensearch_connections: connectionCount,
      clickhouse_clusters: clusterCount,
    });
  } catch (e) {
    res.status(503).json({ ok: false, status: 'not_ready', error: e.message });
  }
});

// ── /api/metrics ─────────────────────────────────────────────────────────────
// Operational metrics: ingestion rates, pipeline health, DLQ totals, memory.
// No auth required — these are consumed by monitoring dashboards / Prometheus scrapers.
router.get('/metrics', (req, res) => {
  try {
    const db = getDb();

    // Ingestion rate (sliding window)
    const rate60 = metrics.getRate(60);
    const rate5  = metrics.getRate(5);

    // Aggregate pipeline counters from pipeline_status
    const agg = db.prepare(`
      SELECT
        COUNT(*)                                           AS total_pipelines,
        SUM(CASE WHEN p.status = 'active'  THEN 1 ELSE 0 END) AS active_pipelines,
        SUM(CASE WHEN p.status = 'paused'  THEN 1 ELSE 0 END) AS paused_pipelines,
        SUM(CASE WHEN ps.status = 'error'  THEN 1 ELSE 0 END) AS erroring_pipelines,
        COALESCE(SUM(ps.rows_inserted_total), 0)          AS rows_inserted_total,
        COALESCE(SUM(ps.rows_inserted_today), 0)          AS rows_inserted_today,
        COALESCE(SUM(ps.rows_skipped_dedup), 0)           AS rows_skipped_dedup,
        COALESCE(SUM(ps.rows_dlq), 0)                     AS rows_dlq_total,
        COALESCE(SUM(ps.bytes_processed), 0)              AS bytes_processed_total
      FROM pipelines p
      LEFT JOIN pipeline_status ps ON p.id = ps.pipeline_id
    `).get();

    // DLQ breakdown: pending vs resolved
    const dlq = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END), 0) AS resolved
      FROM pipeline_dlq
    `).get();

    // Per-pipeline summary (most recent error + last run info)
    const pipelines = db.prepare(`
      SELECT
        p.id, p.name, p.status,
        ps.status         AS run_status,
        ps.last_run_at,
        ps.last_error,
        ps.rows_inserted_total,
        ps.rows_inserted_today,
        COALESCE(ps.rows_dlq, 0) AS rows_dlq,
        ps.last_batch_size,
        ps.checkpoint_committed_at
      FROM pipelines p
      LEFT JOIN pipeline_status ps ON p.id = ps.pipeline_id
      ORDER BY p.name
    `).all();

    // Node.js process memory
    const mem = process.memoryUsage();

    res.json({
      ok: true,
      uptime_secs: metrics.getUptimeSeconds(),
      time: new Date().toISOString(),

      ingestion: {
        last_60s: rate60,
        last_5s: rate5,
      },

      pipelines: {
        total: agg.total_pipelines,
        active: agg.active_pipelines,
        paused: agg.paused_pipelines,
        erroring: agg.erroring_pipelines,
        rows_inserted_total: agg.rows_inserted_total,
        rows_inserted_today: agg.rows_inserted_today,
        rows_skipped_dedup: agg.rows_skipped_dedup,
        rows_dlq_total: agg.rows_dlq_total,
        bytes_processed_total: agg.bytes_processed_total,
      },

      dlq: {
        pending: dlq.pending,
        resolved: dlq.resolved,
      },

      per_pipeline: pipelines,

      process: {
        heap_used_mb: parseFloat((mem.heapUsed / 1024 / 1024).toFixed(2)),
        heap_total_mb: parseFloat((mem.heapTotal / 1024 / 1024).toFixed(2)),
        rss_mb: parseFloat((mem.rss / 1024 / 1024).toFixed(2)),
        external_mb: parseFloat((mem.external / 1024 / 1024).toFixed(2)),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
