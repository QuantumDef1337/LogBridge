const router = require('express').Router();
const { getDb } = require('../db');
const { requireAuth } = require('../auth');
const scheduler = require('../scheduler');
const { decryptRow } = require('../crypto');
const audit = require('../audit');

router.use(requireAuth);

const PIPELINE_FIELDS = `
  p.id, p.name, p.description, p.status,
  p.opensearch_connection_id, oc.name as connection_name,
  p.index_pattern, p.index_set_filter, p.pull_mode, p.pull_from_date, p.pull_to_date,
  p.clickhouse_cluster_id, cc.name as cluster_name,
  p.clickhouse_database, p.clickhouse_table,
  p.field_mappings,
  p.customer_source, p.customer_value,
  p.product_source, p.product_value,
  p.batch_mode, p.batch_size, p.batch_timeout_ms,
  p.dedup_enabled, p.dedup_field, p.dedup_algo,
  p.poll_interval_secs, p.retry_count, p.pause_on_fail, p.timestamp_field,
  p.excluded_fields,
  p.schedule_cron, p.schedule_lookback_hours, p.parallel_slices,
  p.created_at, p.updated_at,
  ps.status as run_status, ps.last_run_at, ps.last_success_at, ps.last_error,
  ps.rows_inserted_total, ps.rows_inserted_today, ps.rows_inserted_week,
  ps.rows_skipped_dedup, ps.cursor_timestamp, ps.cursor_id,
  ps.oldest_source_ts, ps.newest_source_ts, ps.source_doc_count, ps.bytes_processed,
  ps.checkpoint_index, ps.checkpoint_sort, ps.checkpoint_committed_at, ps.last_batch_size,
  ps.rows_dlq, ps.rows_failed,
  ps.last_run_duration_ms, ps.event_lag_secs
`;

const PIPELINE_JOIN = `
  FROM pipelines p
  LEFT JOIN opensearch_connections oc ON p.opensearch_connection_id = oc.id
  LEFT JOIN clickhouse_clusters cc ON p.clickhouse_cluster_id = cc.id
  LEFT JOIN pipeline_status ps ON p.id = ps.pipeline_id
`;

router.get('/', (req, res) => {
  const { search, status, customer, product } = req.query;
  let sql = `SELECT ${PIPELINE_FIELDS} ${PIPELINE_JOIN} WHERE 1=1`;
  const params = [];
  if (search) { sql += ' AND (p.name LIKE ? OR p.description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  if (status) { sql += ' AND p.status = ?'; params.push(status); }
  if (customer) { sql += ' AND p.customer_value LIKE ?'; params.push(`%${customer}%`); }
  if (product) { sql += ' AND p.product_value LIKE ?'; params.push(`%${product}%`); }
  sql += ' ORDER BY p.name';
  const rows = getDb().prepare(sql).all(...params);
  res.json(rows.map(r => ({ ...parsePipeline(r), is_running: scheduler.isRunning(r.id) })));
});

router.get('/:id', (req, res) => {
  const row = getDb().prepare(`SELECT ${PIPELINE_FIELDS} ${PIPELINE_JOIN} WHERE p.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(parsePipeline(row));
});

router.post('/', (req, res) => {
  const db = getDb();
  const p = req.body;
  if (!p.name) return res.status(400).json({ error: 'name required' });

  const r = db.prepare(`
    INSERT INTO pipelines (
      name, description, status,
      opensearch_connection_id, index_pattern, index_set_filter, pull_mode, pull_from_date, pull_to_date,
      clickhouse_cluster_id, clickhouse_database, clickhouse_table,
      field_mappings,
      customer_source, customer_value, product_source, product_value,
      batch_mode, batch_size, batch_timeout_ms,
      dedup_enabled, dedup_field, dedup_algo,
      poll_interval_secs, retry_count, pause_on_fail, timestamp_field, excluded_fields,
      schedule_cron, schedule_lookback_hours, parallel_slices
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    p.name, p.description || '', 'paused',
    p.opensearch_connection_id || null, p.index_pattern || '', JSON.stringify(p.index_set_filter || []),
    p.pull_mode || 'continuous', p.pull_from_date || null, p.pull_to_date || null,
    p.clickhouse_cluster_id || null, p.clickhouse_database || '', p.clickhouse_table || '',
    JSON.stringify(p.field_mappings || []),
    p.customer_source || 'field', p.customer_value || '_customer',
    p.product_source || 'field', p.product_value || '_product',
    p.batch_mode || 'both', p.batch_size || 2000, p.batch_timeout_ms || 5000,
    p.dedup_enabled !== false ? 1 : 0, p.dedup_field || 'raw_data', p.dedup_algo || 'md5',
    p.poll_interval_secs || 30, p.retry_count || 3, p.pause_on_fail !== false ? 1 : 0,
    p.timestamp_field || '@timestamp',
    JSON.stringify(p.excluded_fields || []),
    p.schedule_cron || null, p.schedule_lookback_hours || 24, p.parallel_slices || 1
  );

  // Create initial status row
  db.prepare('INSERT OR IGNORE INTO pipeline_status (pipeline_id) VALUES (?)').run(r.lastInsertRowid);
  audit.info('pipeline', `Pipeline created: "${p.name}" → ${p.clickhouse_database || '?'}.${p.clickhouse_table || '?'}`, r.lastInsertRowid);
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const p = { ...existing, ...req.body };

  db.prepare(`
    UPDATE pipelines SET
      name=?, description=?,
      opensearch_connection_id=?, index_pattern=?, index_set_filter=?, pull_mode=?, pull_from_date=?, pull_to_date=?,
      clickhouse_cluster_id=?, clickhouse_database=?, clickhouse_table=?,
      field_mappings=?,
      customer_source=?, customer_value=?, product_source=?, product_value=?,
      batch_mode=?, batch_size=?, batch_timeout_ms=?,
      dedup_enabled=?, dedup_field=?, dedup_algo=?,
      poll_interval_secs=?, retry_count=?, pause_on_fail=?, timestamp_field=?, excluded_fields=?,
      schedule_cron=?, schedule_lookback_hours=?, parallel_slices=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    p.name, p.description || '',
    p.opensearch_connection_id, p.index_pattern, JSON.stringify(typeof p.index_set_filter === 'string' ? JSON.parse(p.index_set_filter) : p.index_set_filter || []),
    p.pull_mode, p.pull_from_date || null, p.pull_to_date || null,
    p.clickhouse_cluster_id, p.clickhouse_database, p.clickhouse_table,
    JSON.stringify(typeof p.field_mappings === 'string' ? JSON.parse(p.field_mappings) : p.field_mappings || []),
    p.customer_source, p.customer_value, p.product_source, p.product_value,
    p.batch_mode, p.batch_size, p.batch_timeout_ms,
    p.dedup_enabled ? 1 : 0, p.dedup_field, p.dedup_algo,
    p.poll_interval_secs, p.retry_count, p.pause_on_fail ? 1 : 0,
    p.timestamp_field || '@timestamp',
    JSON.stringify(typeof p.excluded_fields === 'string' ? JSON.parse(p.excluded_fields) : p.excluded_fields || []),
    p.schedule_cron || null, p.schedule_lookback_hours || 24, p.parallel_slices || 1,
    req.params.id
  );
  audit.info('pipeline', `Pipeline updated: "${p.name}"`, parseInt(req.params.id));
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const row = getDb().prepare('SELECT name FROM pipelines WHERE id = ?').get(req.params.id);
  getDb().prepare('DELETE FROM pipelines WHERE id = ?').run(req.params.id);
  audit.warn('pipeline', `Pipeline deleted: "${row?.name || req.params.id}"`);
  res.json({ ok: true });
});

router.post('/:id/start', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT name FROM pipelines WHERE id=?').get(req.params.id);
  db.prepare("UPDATE pipelines SET status='active', updated_at=datetime('now') WHERE id=?").run(req.params.id);
  db.prepare("UPDATE pipeline_status SET status='idle', last_error=NULL WHERE pipeline_id=?").run(req.params.id);
  scheduler.triggerNow(req.params.id);
  audit.info('pipeline', `Pipeline started: "${row?.name}"`, parseInt(req.params.id));
  res.json({ ok: true });
});

router.post('/:id/pause', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT name FROM pipelines WHERE id=?').get(req.params.id);
  db.prepare("UPDATE pipelines SET status='paused', updated_at=datetime('now') WHERE id=?").run(req.params.id);
  db.prepare("UPDATE pipeline_status SET status='idle' WHERE pipeline_id=?").run(req.params.id);
  scheduler.cancel(req.params.id);
  audit.info('pipeline', `Pipeline paused: "${row?.name}"`, parseInt(req.params.id));
  res.json({ ok: true });
});

router.post('/:id/reset-cursor', (req, res) => {
  const row = getDb().prepare('SELECT name FROM pipelines WHERE id=?').get(req.params.id);
  getDb().prepare('UPDATE pipeline_status SET cursor_timestamp=NULL, cursor_id=NULL WHERE pipeline_id=?').run(req.params.id);
  // Also reset per-index cursors if any
  getDb().prepare('UPDATE pipeline_indexes SET cursor_timestamp=NULL, cursor_id=NULL WHERE pipeline_id=?').run(req.params.id);
  audit.warn('pipeline', `Cursor reset: "${row?.name}" — next run will re-pull from the beginning`, parseInt(req.params.id));
  res.json({ ok: true });
});

router.get('/:id/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const rows = getDb().prepare(
    'SELECT id, level, message, created_at FROM pipeline_logs WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(req.params.id, limit);
  res.json(rows);
});

// Reset row counters for a pipeline (Today + Total + Week)
router.post('/:id/reset-stats', (req, res) => {
  const row = getDb().prepare('SELECT name FROM pipelines WHERE id=?').get(req.params.id);
  getDb().prepare(
    'UPDATE pipeline_status SET rows_inserted_total=0, rows_inserted_today=0, rows_inserted_week=0, rows_dlq=0 WHERE pipeline_id=?'
  ).run(req.params.id);
  audit.warn('pipeline', `Stats reset: "${row?.name}" — Today/Total counters cleared`, parseInt(req.params.id));
  res.json({ ok: true });
});

// Stats summary across all pipelines
router.get('/stats/summary', (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM pipelines').get().c;
  const active = db.prepare("SELECT COUNT(*) as c FROM pipelines WHERE status='active'").get().c;
  const paused = db.prepare("SELECT COUNT(*) as c FROM pipelines WHERE status='paused'").get().c;
  const erroring = db.prepare("SELECT COUNT(*) as c FROM pipeline_status WHERE status='error'").get().c;
  const rows_today = db.prepare('SELECT COALESCE(SUM(rows_inserted_today),0) as t FROM pipeline_status').get().t;
  const rows_total = db.prepare('SELECT COALESCE(SUM(rows_inserted_total),0) as t FROM pipeline_status').get().t;
  const bytes = db.prepare('SELECT COALESCE(SUM(bytes_processed),0) as t FROM pipeline_status').get().t;
  res.json({ total, active, paused, erroring, rows_today, rows_total, bytes_processed: bytes });
});

// ─── Test / Run-now endpoints ────────────────────────────────────────────────

const runner = require('../runner');

function loadRunContext(pipelineId) {
  const db = getDb();
  const p = db.prepare(`SELECT ${PIPELINE_FIELDS} ${PIPELINE_JOIN} WHERE p.id = ?`).get(pipelineId);
  if (!p) return null;
  const pipeline = parsePipeline(p);
  const conn = decryptRow(db.prepare('SELECT * FROM opensearch_connections WHERE id = ?').get(pipeline.opensearch_connection_id));
  const cluster = decryptRow(db.prepare('SELECT * FROM clickhouse_clusters WHERE id = ?').get(pipeline.clickhouse_cluster_id));
  return { pipeline, conn, cluster };
}

// Dry run: pull one page, transform, return sample rows WITHOUT inserting.
router.post('/:id/test-run', async (req, res) => {
  const ctx = loadRunContext(req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Pipeline not found' });
  if (!ctx.conn) return res.status(400).json({ error: 'No OpenSearch connection configured' });
  try {
    const out = await runner.runPipelineOnce(ctx.conn, ctx.cluster, ctx.pipeline, { dryRun: true });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Run now: pull from cursor (respecting pull mode / time range), transform, insert.
// Respects the scheduler execution lock — returns 409 if this pipeline is already running.
router.post('/:id/run-now', async (req, res) => {
  const pipelineId = req.params.id;

  // Execution lock: never run a pipeline concurrently with itself
  if (scheduler.isRunning(pipelineId)) {
    return res.status(409).json({
      ok: false,
      alreadyRunning: true,
      error: 'Pipeline is already executing — wait for it to finish or pause it first',
    });
  }

  const ctx = loadRunContext(pipelineId);
  if (!ctx) return res.status(404).json({ error: 'Pipeline not found' });
  if (!ctx.conn) return res.status(400).json({ error: 'No OpenSearch connection configured' });
  if (!ctx.cluster) return res.status(400).json({ error: 'No ClickHouse cluster configured' });
  if (!ctx.pipeline.clickhouse_table) return res.status(400).json({ error: 'No destination table selected' });

  const db = getDb();
  const maxPages = Math.min(parseInt(req.body?.max_pages || '20'), 200);
  const physicalIndexes = ctx.pipeline.index_set_filter;

  try {
    let out;
    if (ctx.pipeline.pull_mode === 'scheduled') {
      // Scheduled mode: cursor-based window (cursor_timestamp → now).
      const opts = req.body?.forceFrom ? { forceFrom: new Date(req.body.forceFrom) } : {};
      out = await runner.runScheduledSlices(ctx.conn, ctx.cluster, ctx.pipeline, opts);
    } else if (ctx.pipeline.pull_mode === 'date_range' && (ctx.pipeline.parallel_slices || 1) > 1) {
      // date_range + parallel workers: same time-window partitioning over the explicit range.
      const from = new Date(ctx.pipeline.pull_from_date);
      const to   = ctx.pipeline.pull_to_date ? new Date(ctx.pipeline.pull_to_date) : new Date();
      out = await runner.runScheduledSlices(ctx.conn, ctx.cluster, ctx.pipeline, { forceFrom: from, to });
    } else if (physicalIndexes && physicalIndexes.length > 0) {
      // Multi-index mode: run each physical index using per-index cursors (same as scheduler)
      let totalFetched = 0, totalInserted = 0, totalDlq = 0;
      for (const indexName of physicalIndexes) {
        const ir = await runner.runIndexPartition(ctx.conn, ctx.cluster, ctx.pipeline, indexName, { maxPages });
        totalFetched += ir.fetched; totalInserted += ir.inserted; totalDlq += ir.dlq;
      }
      out = { fetched: totalFetched, inserted: totalInserted, dlq: totalDlq };
    } else {
      // Single-pattern mode: use pipeline-level cursor
      const st = db.prepare('SELECT cursor_timestamp, cursor_id FROM pipeline_status WHERE pipeline_id = ?').get(pipelineId) || {};
      out = await runner.runPipelineOnce(ctx.conn, ctx.cluster, ctx.pipeline, {
        startTs: st.cursor_timestamp || null,
        startId: st.cursor_id || null,
        maxPages,
      });
    }

    db.prepare("UPDATE pipeline_status SET status='idle', last_error=NULL WHERE pipeline_id=?").run(pipelineId);
    db.prepare("INSERT INTO pipeline_logs (pipeline_id, level, message) VALUES (?, 'info', ?)")
      .run(pipelineId, `Run-now: fetched ${out.fetched}, inserted ${out.inserted}, dlq ${out.dlq || 0}`);

    res.json({ ok: true, ...out });
  } catch (e) {
    // Infra failure surviving all retries: pause so checkpoint is preserved.
    const now = new Date().toISOString();
    db.prepare("UPDATE pipelines SET status='paused' WHERE id=?").run(pipelineId);
    db.prepare("UPDATE pipeline_status SET status='error', last_error=?, last_run_at=? WHERE pipeline_id=?")
      .run(`${e.category || 'error'}: ${e.message}`, now, pipelineId);
    db.prepare("INSERT INTO pipeline_logs (pipeline_id, level, message) VALUES (?, 'error', ?)")
      .run(pipelineId, `Run paused after retries (${e.category || 'error'}): ${e.message}`);
    res.status(400).json({ ok: false, error: e.message, category: e.category, paused: true });
  }
});

// ── Per-physical-index partitions ────────────────────────────────────────────

router.get('/:id/partitions', (req, res) => {
  const rows = getDb().prepare(
    `SELECT index_name, status, cursor_timestamp, cursor_id, checkpoint_committed_at,
            rows_inserted, rows_dlq, last_error, last_run_at
     FROM pipeline_indexes WHERE pipeline_id = ? ORDER BY index_name`
  ).all(req.params.id);
  res.json(rows);
});

router.delete('/:id/partitions/:indexName/cursor', (req, res) => {
  getDb().prepare(
    'UPDATE pipeline_indexes SET cursor_timestamp=NULL, cursor_id=NULL WHERE pipeline_id=? AND index_name=?'
  ).run(req.params.id, req.params.indexName);
  res.json({ ok: true });
});

// ── ClickHouse table storage stats ───────────────────────────────────────────
// Real row count + compressed / uncompressed size from system.parts.
// This is the ground truth — independent of LogBridge's tracking counters.
router.get('/:id/ch-stats', async (req, res) => {
  const ctx = loadRunContext(req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Pipeline not found' });
  if (!ctx.cluster) return res.status(400).json({ error: 'No ClickHouse cluster configured' });
  const { clickhouse_database: db, clickhouse_table: table } = ctx.pipeline;
  if (!db || !table) return res.status(400).json({ error: 'No destination table configured' });

  try {
    const sql = `
      SELECT
        SUM(rows)                AS rows,
        SUM(bytes_on_disk)       AS compressed_bytes,
        SUM(data_uncompressed_bytes) AS uncompressed_bytes,
        COUNT()                  AS part_count
      FROM system.parts
      WHERE database = '${db.replace(/'/g, "''")}'
        AND table = '${table.replace(/'/g, "''")}'
        AND active = 1
    `;
    const result = await ch_svc.query(ctx.cluster, sql);
    const row = result.data?.[0] || {};
    res.json({
      rows: Number(row.rows ?? 0),
      compressed_bytes: Number(row.compressed_bytes ?? 0),
      uncompressed_bytes: Number(row.uncompressed_bytes ?? 0),
      part_count: Number(row.part_count ?? 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Reconciliation ────────────────────────────────────────────────────────────
// Compare source event count (OpenSearch) vs destination (ClickHouse) for the pipeline.
// Accepts optional ?from= and ?to= ISO date strings to scope the comparison.

const os_svc = require('../services/opensearch');
const ch_svc = require('../services/clickhouse');

router.post('/:id/reconcile', async (req, res) => {
  const ctx = loadRunContext(req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Pipeline not found' });
  if (!ctx.conn) return res.status(400).json({ error: 'No OpenSearch connection configured' });
  if (!ctx.cluster) return res.status(400).json({ error: 'No ClickHouse cluster configured' });
  if (!ctx.pipeline.clickhouse_table) return res.status(400).json({ error: 'No destination table configured' });

  const { pipeline, conn, cluster } = ctx;
  const tsField = pipeline.timestamp_field || '@timestamp';

  // ── Mode-aware reconciliation window ────────────────────────────────────────
  // The range we compare over depends on what the pipeline was configured to pull:
  //   date_range → [from, to]   from_date → [from, now]   continuous/scheduled → whole index
  // An explicit {from,to} in the request body overrides (used by manual re-checks).
  let fromDate, toDate;
  if (req.body?.from || req.body?.to) {
    fromDate = req.body.from; toDate = req.body.to;
  } else if (pipeline.pull_mode === 'date_range') {
    fromDate = pipeline.pull_from_date; toDate = pipeline.pull_to_date;
  } else if (pipeline.pull_mode === 'from_date') {
    fromDate = pipeline.pull_from_date; toDate = null;
  } // continuous / scheduled → no bounds (compare the whole index)

  const range = {};
  if (fromDate) range.gte = fromDate;
  if (toDate) range.lte = toDate;

  // Scope the source count to the physically-selected indexes if any, else the pattern.
  let indexList;
  try { indexList = JSON.parse(pipeline.index_set_filter || '[]'); } catch { indexList = []; }
  const target = indexList.length ? indexList.join(',') : pipeline.index_pattern;

  let source = null, dest = null, error = null;
  try {
    source = await os_svc.getRangeStats(conn, target, range, tsField);
  } catch (e) {
    error = `OpenSearch: ${e.message}`;
  }
  try {
    // Normalize ISO dates (2026-02-08T17:59) → ClickHouse format (2026-02-08 17:59:00).
    const toChDate = (s) => s.replace(/'/g, '').replace('T', ' ').replace(/Z$/, '') + (s.includes(':') && s.split(':').length < 3 ? ':00' : '');
    const parts = [];
    if (fromDate) parts.push(`timestamp >= '${toChDate(fromDate)}'`);
    if (toDate) parts.push(`timestamp <= '${toChDate(toDate)}'`);
    dest = await ch_svc.getRangeStats(cluster, pipeline.clickhouse_database, pipeline.clickhouse_table, parts.join(' AND '));
  } catch (e) {
    error = (error ? error + '; ' : '') + `ClickHouse: ${e.message}`;
  }

  const sourceCount = source?.count ?? null;
  const destCount = dest?.count ?? null;
  let status = 'INCONCLUSIVE';
  let remaining = null;
  if (sourceCount !== null && destCount !== null) {
    status = sourceCount === destCount ? 'MATCH' : 'MISMATCH';
    remaining = Math.max(0, sourceCount - destCount);
  }

  res.json({
    ok: true,
    overall: status,
    window: { from: fromDate || null, to: toDate || null, mode: pipeline.pull_mode },
    source,          // { count, oldest_ts, newest_ts }
    dest,            // { count, oldest_ts, newest_ts }
    remaining,       // source.count − dest.count (docs still to ingest)
    // Back-compat single row for the existing table renderer.
    indexes: [{ index: target, source_count: sourceCount, dest_count: destCount, status, error }],
  });
});

// ── Dead Letter Queue ────────────────────────────────────────────────────────

router.get('/:id/dlq', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const rows = getDb().prepare(
    `SELECT id, source_index, source_doc_id, event_timestamp, error_message, error_category,
            retry_count, first_failure_at, last_failure_at, status
     FROM pipeline_dlq WHERE pipeline_id = ? AND status = 'pending' ORDER BY id DESC LIMIT ?`
  ).all(req.params.id, limit);
  const count = getDb().prepare("SELECT COUNT(*) c FROM pipeline_dlq WHERE pipeline_id = ? AND status = 'pending'").get(req.params.id).c;
  res.json({ count, items: rows });
});

router.get('/:id/dlq/:dlqId', (req, res) => {
  const row = getDb().prepare('SELECT * FROM pipeline_dlq WHERE id = ? AND pipeline_id = ?').get(req.params.dlqId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// Retry DLQ items: re-transform and re-insert the stored documents.
router.post('/:id/dlq/retry', async (req, res) => {
  const ctx = loadRunContext(req.params.id);
  if (!ctx || !ctx.cluster) return res.status(400).json({ error: 'Pipeline/cluster not configured' });
  const db = getDb();
  const items = db.prepare("SELECT id, document FROM pipeline_dlq WHERE pipeline_id = ? AND status = 'pending' LIMIT 5000").all(req.params.id);
  if (!items.length) return res.json({ ok: true, retried: 0, recovered: 0 });

  let recovered = 0, stillFailing = 0;
  for (const item of items) {
    try {
      const doc = JSON.parse(item.document);
      const row = runner.transformDoc(doc, ctx.pipeline);
      await ch.insertRows(ctx.cluster, ctx.pipeline.clickhouse_database, ctx.pipeline.clickhouse_table, JSON.stringify(row));
      db.prepare("UPDATE pipeline_dlq SET status='resolved', last_failure_at=datetime('now') WHERE id=?").run(item.id);
      recovered++;
    } catch (e) {
      db.prepare("UPDATE pipeline_dlq SET retry_count = retry_count + 1, error_message=?, last_failure_at=datetime('now') WHERE id=?")
        .run((e.message || '').slice(0, 2000), item.id);
      stillFailing++;
    }
  }
  res.json({ ok: true, retried: items.length, recovered, stillFailing });
});

router.delete('/:id/dlq', (req, res) => {
  getDb().prepare('DELETE FROM pipeline_dlq WHERE pipeline_id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.delete('/:id/dlq/:dlqId', (req, res) => {
  getDb().prepare('DELETE FROM pipeline_dlq WHERE id = ? AND pipeline_id = ?').run(req.params.dlqId, req.params.id);
  res.json({ ok: true });
});

function parsePipeline(row) {
  try { row.field_mappings = JSON.parse(row.field_mappings || '[]'); } catch { row.field_mappings = []; }
  try { row.index_set_filter = JSON.parse(row.index_set_filter || '[]'); } catch { row.index_set_filter = []; }
  try { row.excluded_fields = JSON.parse(row.excluded_fields || '[]'); } catch { row.excluded_fields = []; }
  row.schedule_lookback_hours = row.schedule_lookback_hours || 24;
  row.parallel_slices = row.parallel_slices || 1;
  return row;
}

module.exports = router;
