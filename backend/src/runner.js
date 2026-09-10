const crypto = require('crypto');
const os = require('./services/opensearch');
const ch = require('./services/clickhouse');
const { getDb } = require('./db');
const { withRetry } = require('./retry');
const metrics = require('./services/metrics');

// Save the active PIT id so it survives across pages within one run.
function savePitId(pipelineId, pitId) {
  getDb().prepare("UPDATE pipeline_status SET pit_id=? WHERE pipeline_id=?").run(pitId || null, pipelineId);
}

// Restore the last saved PIT id (may be stale/expired — caller must handle that).
function loadPitId(pipelineId) {
  const row = getDb().prepare('SELECT pit_id FROM pipeline_status WHERE pipeline_id=?').get(pipelineId);
  return row?.pit_id || null;
}

// ── Per-index-partition checkpoint helpers ────────────────────────────────────

function savePitIdForIndex(pipelineId, indexName, pitId) {
  const db = getDb();
  db.prepare(`
    INSERT INTO pipeline_indexes (pipeline_id, index_name, pit_id)
    VALUES (?, ?, ?)
    ON CONFLICT(pipeline_id, index_name) DO UPDATE SET pit_id = excluded.pit_id
  `).run(pipelineId, indexName, pitId || null);
}

function loadPitIdForIndex(pipelineId, indexName) {
  const row = getDb().prepare('SELECT pit_id FROM pipeline_indexes WHERE pipeline_id=? AND index_name=?').get(pipelineId, indexName);
  return row?.pit_id || null;
}

function commitIndexCheckpoint(pipelineId, indexName, cursor, stats) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pipeline_indexes
      (pipeline_id, index_name, status, cursor_timestamp, cursor_id, checkpoint_sort, checkpoint_committed_at, rows_inserted, rows_dlq, last_run_at)
    VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pipeline_id, index_name) DO UPDATE SET
      cursor_timestamp        = excluded.cursor_timestamp,
      cursor_id               = excluded.cursor_id,
      checkpoint_sort         = excluded.checkpoint_sort,
      checkpoint_committed_at = excluded.checkpoint_committed_at,
      rows_inserted = COALESCE(pipeline_indexes.rows_inserted, 0) + ?,
      rows_dlq      = COALESCE(pipeline_indexes.rows_dlq, 0) + ?,
      last_run_at   = excluded.last_run_at,
      status        = excluded.status
  `).run(
    pipelineId, indexName,
    cursor.ts, cursor.id,
    JSON.stringify([cursor.ts, cursor.id]),
    now,
    stats.inserted, stats.dlq,
    now,
    stats.inserted, stats.dlq
  );
  // Also roll up into the aggregate pipeline_status
  commitCheckpoint(pipelineId, cursor, stats);
}

// Write failed events to the Dead Letter Queue — never silently dropped.
function toDlq(pipelineId, docs, err) {
  const db = getDb();
  const now = new Date().toISOString();
  const cat = err?.category || 'unknown';
  const msg = (err?.message || String(err)).slice(0, 2000);
  const stmt = db.prepare(`
    INSERT INTO pipeline_dlq
      (pipeline_id, source_index, source_doc_id, event_timestamp, document, error_message, error_category, retry_count, first_failure_at, last_failure_at, status)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'pending')
  `);
  for (const d of docs) {
    stmt.run(
      pipelineId,
      d._index || '',
      d._id || '',
      d['@timestamp'] || d.timestamp || null,
      JSON.stringify(d).slice(0, 1000000),
      msg, cat, err?.attempts || 0, now, now
    );
  }
}

// Commit the durable checkpoint AFTER a batch is confirmed written (critical no-data-loss rule).
function commitCheckpoint(pipelineId, cursor, stats) {
  const db = getDb();
  const nowDate = new Date();
  const now = nowDate.toISOString();

  // Event lag: difference between wall-clock now and the @timestamp of the last event processed.
  // For historical data this will be large (days/months); for near-real-time it will be seconds.
  let eventLagSecs = null;
  if (cursor.ts) {
    try {
      const eventTime = new Date(cursor.ts).getTime();
      if (!isNaN(eventTime)) eventLagSecs = Math.round((nowDate.getTime() - eventTime) / 1000);
    } catch {}
  }

  db.prepare(`
    INSERT INTO pipeline_status
      (pipeline_id, status, cursor_timestamp, cursor_id, checkpoint_index, checkpoint_sort,
       checkpoint_committed_at, last_batch_size, last_run_at, last_success_at,
       rows_inserted_total, rows_inserted_today, rows_skipped_dedup, rows_dlq,
       bytes_processed, oldest_source_ts, last_run_duration_ms, event_lag_secs, updated_at)
    VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pipeline_id) DO UPDATE SET
      cursor_timestamp = excluded.cursor_timestamp,
      cursor_id = excluded.cursor_id,
      checkpoint_index = excluded.checkpoint_index,
      checkpoint_sort = excluded.checkpoint_sort,
      checkpoint_committed_at = excluded.checkpoint_committed_at,
      last_batch_size = excluded.last_batch_size,
      last_run_at = excluded.last_run_at,
      last_success_at = excluded.last_success_at,
      rows_inserted_total = COALESCE(pipeline_status.rows_inserted_total,0) + ?,
      rows_inserted_today = COALESCE(pipeline_status.rows_inserted_today,0) + ?,
      rows_skipped_dedup  = COALESCE(pipeline_status.rows_skipped_dedup,0) + ?,
      rows_dlq            = COALESCE(pipeline_status.rows_dlq,0) + ?,
      bytes_processed     = COALESCE(pipeline_status.bytes_processed,0) + ?,
      oldest_source_ts    = COALESCE(pipeline_status.oldest_source_ts, excluded.oldest_source_ts),
      last_run_duration_ms = excluded.last_run_duration_ms,
      event_lag_secs       = excluded.event_lag_secs,
      updated_at = excluded.updated_at
  `).run(
    pipelineId, cursor.ts, cursor.id, cursor.index || '',
    JSON.stringify([cursor.ts, cursor.id]), now, stats.batchSize,
    now, now,
    stats.inserted, stats.inserted, stats.skipped, stats.dlq, stats.bytes || 0,
    stats.oldestTs || null,
    stats.durationMs || 0, eventLagSecs,
    now,
    stats.inserted, stats.inserted, stats.skipped, stats.dlq, stats.bytes || 0
  );
}

// Write a structured log entry to pipeline_logs (visible in Jobs live feed).
function pipelineLog(pipelineId, level, message) {
  try {
    getDb().prepare(
      "INSERT INTO pipeline_logs (pipeline_id, level, message) VALUES (?, ?, ?)"
    ).run(pipelineId, level, message);
  } catch {}
}

// Read a nested field by dot-path, e.g. "agent.name" or "@timestamp"
function getNested(doc, path) {
  if (!path) return undefined;
  const parts = path.split('.');
  let cur = doc;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function hash(algo, str) {
  return crypto.createHash(algo === 'sha256' ? 'sha256' : 'md5').update(str).digest('hex');
}

// Immutably delete a dot-path from an object, e.g. ['agent', 'name'] removes obj.agent.name.
function deleteNestedPath(obj, parts) {
  if (!obj || typeof obj !== 'object' || parts.length === 0) return obj;
  const copy = { ...obj };
  if (parts.length === 1) {
    delete copy[parts[0]];
    return copy;
  }
  const key = parts[0];
  if (key in copy) copy[key] = deleteNestedPath(copy[key], parts.slice(1));
  return copy;
}

// Strip excluded_fields from a doc before JSON.stringify for raw_data.
// Supports top-level keys ("_id") and dot-paths ("agent.name").
function applyExclusions(doc, excludedFields) {
  const topLevel = new Set();
  const nested = [];
  for (const f of excludedFields) {
    const dot = f.indexOf('.');
    if (dot === -1) topLevel.add(f);
    else nested.push(f.split('.'));
  }
  let result = topLevel.size > 0
    ? Object.fromEntries(Object.entries(doc).filter(([k]) => !topLevel.has(k)))
    : { ...doc };
  for (const parts of nested) result = deleteNestedPath(result, parts);
  return result;
}

// Transform one OpenSearch doc into a ClickHouse row using the pipeline's field mappings.
function transformDoc(doc, pipeline) {
  const row = {};

  for (const m of pipeline.field_mappings || []) {
    if (!m.dest) continue;
    let val;
    switch (m.source_type) {
      case 'field':    val = getNested(doc, m.source_value); break;
      case 'static':   val = m.source_value; break;
      case 'full_doc': {
        const excludedList = Array.isArray(pipeline.excluded_fields) ? pipeline.excluded_fields : [];
        if (excludedList.length > 0) {
          val = JSON.stringify(applyExclusions(doc, excludedList));
        } else {
          val = JSON.stringify(doc);
        }
        break;
      }
      case 'now':      val = new Date().toISOString(); break;
      case 'md5':      val = hash('md5', String(getNested(doc, m.source_value) ?? '')); break;
      default:         val = null;
    }
    // Plain objects get JSON-encoded for String columns.
    // Arrays are kept as-is so ClickHouse Array(String) columns receive a real JSON array.
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) val = JSON.stringify(val);
    // Omit missing/empty values so the column's ClickHouse DEFAULT applies.
    // (Sending "" to a DateTime/UInt column throws CANNOT_PARSE_DATETIME.)
    if (val === undefined || val === null || val === '') continue;
    row[m.dest] = val;
  }

  // Auto-inject customer / product if not already mapped
  if (row.customer === undefined) {
    row.customer = pipeline.customer_source === 'field'
      ? (getNested(doc, pipeline.customer_value) ?? pipeline.customer_value)
      : pipeline.customer_value;
  }
  if (row.product === undefined) {
    row.product = pipeline.product_source === 'field'
      ? (getNested(doc, pipeline.product_value) ?? pipeline.product_value)
      : pipeline.product_value;
  }

  // Compute event_id for dedup if enabled
  if (pipeline.dedup_enabled && row.event_id === undefined) {
    const src = getNested(doc, pipeline.dedup_field);
    let asStr = src !== null && src !== undefined && typeof src === 'object'
      ? JSON.stringify(src)
      : (src ?? '');
    // If the dedup field is missing/empty, hash the whole document instead of ''
    // (otherwise every row would get the identical md5 of an empty string).
    if (asStr === '') asStr = JSON.stringify(doc);
    row.event_id = hash(pipeline.dedup_algo, String(asStr));
  }

  return row;
}

// Build the OpenSearch time-range filter from the pipeline's pull mode.
function buildRange(pipeline) {
  const range = {};
  if (pipeline.pull_mode === 'from_date' && pipeline.pull_from_date) {
    range.gte = pipeline.pull_from_date;
  } else if (pipeline.pull_mode === 'date_range') {
    if (pipeline.pull_from_date) range.gte = pipeline.pull_from_date;
    if (pipeline.pull_to_date) range.lte = pipeline.pull_to_date;
  }
  return range;
}

/**
 * Run a pipeline once (a bounded number of pages).
 * opts.dryRun = true  → transform only, return sample rows, insert nothing (no PIT).
 * opts.usePit = false → force plain search_after (e.g. for small ad-hoc runs).
 * Returns { fetched, inserted, skipped, dlq, sampleRows, nextCursor, error }.
 *
 * PIT lifecycle:
 *   - Open a fresh PIT at the start of each run (or reuse a stored one if still valid).
 *   - If PIT expires mid-run, recreate it and resume from the last committed checkpoint.
 *   - Close (best-effort delete) the PIT at the end of the run.
 *   - Dry-runs skip PIT entirely — they fetch one page with plain search_after.
 */
/**
 * Run a pipeline once (a bounded number of pages).
 *
 * opts.hooks allows callers to override PIT and checkpoint storage — used by
 * runIndexPartition so per-index state goes to pipeline_indexes instead of pipeline_status.
 *   hooks.savePitId(pipelineId, pitId)
 *   hooks.loadPitId(pipelineId) → string|null
 *   hooks.commitCheckpoint(pipelineId, cursor, stats)
 *
 * opts.dryRun = true  → transform only, return sample rows, insert nothing (no PIT).
 * opts.usePit = false → force plain search_after (e.g. for small ad-hoc runs).
 * Returns { fetched, inserted, skipped, dlq, sampleRows, nextCursor, error }.
 */
async function runPipelineOnce(conn, cluster, pipeline, opts = {}) {
  const maxPages = opts.maxPages || (opts.dryRun ? 1 : 20);
  const range = buildRange(pipeline);
  const usePit = !opts.dryRun && opts.usePit !== false;
  const retryOpts = {
    maxAttempts: (pipeline.retry_count || 5) + 1,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
  };

  // Allow callers (runIndexPartition) to override storage hooks
  const hooks = opts.hooks || {};
  const _savePitId = hooks.savePitId || savePitId;
  const _commitCheckpoint = hooks.commitCheckpoint || commitCheckpoint;

  const tsField = pipeline.timestamp_field || '@timestamp';

  let cursorTs = opts.startTs || null;
  let cursorId = opts.startId || null;
  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  let dlq = 0;
  let sampleRows = [];
  let dedupWarned = false; // log the "dedup disabled" warning once per run, not per batch
  let lastCursor = null;
  // Capture the oldest event timestamp once — from the first doc of the first page
  // when starting from scratch (no cursor). Used to populate oldest_source_ts.
  let oldestTs = null;
  let runStartMs = Date.now(); // track wall-clock time for batch duration

  // ── PIT OPEN ────────────────────────────────────────────────────────────────
  let pitId = null;
  if (usePit) {
    try {
      const p = await withRetry(() => os.openPit(conn, pipeline.index_pattern), retryOpts);
      pitId = p.pitId;
      _savePitId(pipeline.id, pitId);
    } catch (e) {
      console.warn(`[pipeline ${pipeline.id}] PIT open failed (${e.message}), falling back to plain search_after`);
    }
  }

  // OS hard limit is 10K per request. batch_size is the logical CH insert size.
  // We accumulate ceil(batch_size / OS_PAGE_SIZE) OS fetches into one CH insert,
  // giving Graylog-style multi-page batching with no OpenSearch limit violation.
  const OS_PAGE_SIZE = Math.min(pipeline.batch_size || 2000, 10000);
  const osPerInsert = Math.max(1, Math.ceil((pipeline.batch_size || 2000) / OS_PAGE_SIZE));

  // Fetch one OS page, handling PIT expiry and fallback internally.
  async function fetchOnePage() {
    if (pitId) {
      try {
        const r = await withRetry(
          () => os.fetchPageWithPit(conn, pitId, OS_PAGE_SIZE, cursorTs, cursorId, range, tsField),
          retryOpts
        );
        if (r.pitId && r.pitId !== pitId) { pitId = r.pitId; _savePitId(pipeline.id, pitId); }
        return r;
      } catch (e) {
        if (!e.pitExpired) throw e;
        console.warn(`[pipeline ${pipeline.id}] PIT expired, recreating…`);
        try {
          const p = await withRetry(() => os.openPit(conn, pipeline.index_pattern), retryOpts);
          pitId = p.pitId; _savePitId(pipeline.id, pitId);
          const r = await withRetry(
            () => os.fetchPageWithPit(conn, pitId, OS_PAGE_SIZE, cursorTs, cursorId, range, tsField),
            retryOpts
          );
          if (r.pitId && r.pitId !== pitId) { pitId = r.pitId; _savePitId(pipeline.id, pitId); }
          return r;
        } catch (e2) {
          console.warn(`[pipeline ${pipeline.id}] PIT recreate failed, falling back: ${e2.message}`);
          pitId = null; _savePitId(pipeline.id, null);
        }
      }
    }
    return withRetry(
      () => os.fetchPage(conn, pipeline.index_pattern, OS_PAGE_SIZE, cursorTs, cursorId, range, tsField),
      retryOpts
    );
  }

  try {
    for (let insertBatch = 0; insertBatch < maxPages; insertBatch++) {
      // ── ACCUMULATE: fetch osPerInsert OS pages into one logical batch ──────
      const accumDocs = [];
      const accumRows = [];
      let accumDlq = 0;
      let batchFirstDoc = null;
      let noMore = false;
      let isFirstBatch = insertBatch === 0;

      for (let p = 0; p < osPerInsert; p++) {
        const { docs, nextCursor } = await fetchOnePage();
        if (!docs.length) { noMore = true; break; }

        if (batchFirstDoc === null) batchFirstDoc = docs[0];
        fetched += docs.length;

        // Capture oldest source timestamp on very first doc of first insert batch
        if (isFirstBatch && p === 0 && !opts.startTs && !oldestTs && docs[0]) {
          oldestTs = docs[0]['@timestamp'] || docs[0].timestamp || null;
        }

        // ── TRANSFORM ────────────────────────────────────────────────────────
        for (const d of docs) {
          try {
            accumRows.push(transformDoc(d, pipeline));
          } catch (e) {
            if (!opts.dryRun) { toDlq(pipeline.id, [d], { message: e.message, category: 'transform' }); accumDlq++; }
          }
        }
        accumDocs.push(...docs);

        if (opts.dryRun) {
          sampleRows = accumRows.slice(0, 5);
          return { fetched, inserted: 0, skipped: 0, dlq: 0, sampleRows, nextCursor, error: null };
        }

        if (!nextCursor) { noMore = true; break; }
        // Advance cursor for next OS page within this insert batch
        cursorTs = nextCursor.ts;
        cursorId = nextCursor.id;
        lastCursor = nextCursor;
      }

      if (!accumDocs.length) break;

      // ── DEDUP CHECK on combined accumulated rows ───────────────────────────
      let insertRows = accumRows;
      const batchEventIds = accumRows.map(r => r.event_id).filter(Boolean);
      if (batchEventIds.length > 0) {
        try {
          const existing = await ch.getExistingEventIds(
            cluster, pipeline.clickhouse_database, pipeline.clickhouse_table, batchEventIds
          );
          if (existing.length > 0) {
            const existingSet = new Set(existing);
            insertRows = accumRows.filter(r => !r.event_id || !existingSet.has(r.event_id));
            skipped += accumRows.length - insertRows.length;
          }
        } catch (e) {
          if (e.dedupUnsupported && !dedupWarned) {
            dedupWarned = true;
            pipelineLog(pipeline.id, 'warn', e.message);
          } else if (!e.dedupUnsupported) {
            throw e;
          }
          // dedup unsupported → fall through and insert without a dedup check
        }
      }

      // ── WRITE: single CH insert for all accumulated OS pages ──────────────
      const batchBytes = Buffer.byteLength(accumRows.map(r => JSON.stringify(r)).join('\n'), 'utf8');
      let batchInserted = 0;
      if (insertRows.length) {
        const ndjson = insertRows.map(r => JSON.stringify(r)).join('\n');
        try {
          await withRetry(
            () => ch.insertRows(cluster, pipeline.clickhouse_database, pipeline.clickhouse_table, ndjson),
            retryOpts
          );
          batchInserted = insertRows.length;
          metrics.recordIngestion(batchInserted, Buffer.byteLength(ndjson, 'utf8'));
          if (sampleRows.length === 0) sampleRows = accumRows.slice(0, 3);
          const batchFromTs = batchFirstDoc?.['@timestamp'] || batchFirstDoc?.timestamp || null;
          const batchToTs   = accumDocs[accumDocs.length - 1]?.['@timestamp'] || accumDocs[accumDocs.length - 1]?.timestamp || null;
          const batchIndexes = [...new Set(accumDocs.map(d => d._index).filter(Boolean))];
          const batchIndex   = batchIndexes.length === 1 ? batchIndexes[0] : batchIndexes.length > 1 ? `${batchIndexes[0]} +${batchIndexes.length - 1}` : null;
          pipelineLog(pipeline.id, 'info',
            `Batch inserted: ${batchInserted} rows (fetched ${accumDocs.length}, skipped ${accumRows.length - insertRows.length} dedup)` +
            (batchFromTs  ? ` | from:${batchFromTs}` : '') +
            (batchToTs    ? ` to:${batchToTs}`        : '') +
            (batchIndex   ? ` | index:${batchIndex}`  : '')
          );
        } catch (err) {
          if (err.retryable) {
            pipelineLog(pipeline.id, 'error', `Insert failed after retries: ${err.message}`);
            throw err;
          }
          // Permanent data error → DLQ the batch, keep advancing
          toDlq(pipeline.id, accumDocs.slice(0, insertRows.length), err);
          accumDlq += insertRows.length;
          pipelineLog(pipeline.id, 'warn',
            `Batch sent to DLQ (${insertRows.length} rows): ${err.message}`
          );
        }
      }

      inserted += batchInserted;
      dlq += accumDlq;

      // ── CHECKPOINT once per combined insert (after CH ack) ────────────────
      if (lastCursor) {
        _commitCheckpoint(pipeline.id, lastCursor, { inserted: batchInserted, skipped: 0, dlq: accumDlq, batchSize: batchInserted, bytes: batchBytes || 0, oldestTs, durationMs: Date.now() - runStartMs });
        runStartMs = Date.now();
      }

      if (noMore || !lastCursor) break;
    }
  } finally {
    if (pitId) {
      os.closePit(conn, pitId).catch(() => {});
      _savePitId(pipeline.id, null);
    }
  }

  if (fetched > 0) {
    pipelineLog(pipeline.id, 'info',
      `Run complete — fetched ${fetched}, inserted ${inserted}, skipped ${skipped} (dedup), dlq ${dlq}`
    );
  }

  return { fetched, inserted, skipped, dlq, sampleRows, nextCursor: lastCursor, error: null };
}

/**
 * Run one physical index partition with independent cursor/checkpoint state.
 * State is stored in pipeline_indexes (not pipeline_status) keyed by (pipeline_id, index_name).
 * The aggregate pipeline_status totals are also incremented via commitIndexCheckpoint.
 */
async function runIndexPartition(conn, cluster, pipeline, indexName, opts = {}) {
  const db = getDb();
  const st = db.prepare(
    'SELECT cursor_timestamp, cursor_id FROM pipeline_indexes WHERE pipeline_id=? AND index_name=?'
  ).get(pipeline.id, indexName) || {};

  // Mark partition as running
  db.prepare(`
    INSERT INTO pipeline_indexes (pipeline_id, index_name, status, last_run_at)
    VALUES (?, ?, 'running', datetime('now'))
    ON CONFLICT(pipeline_id, index_name) DO UPDATE SET status='running', last_run_at=datetime('now')
  `).run(pipeline.id, indexName);

  const partitionPipeline = { ...pipeline, index_pattern: indexName };

  const result = await runPipelineOnce(conn, cluster, partitionPipeline, {
    ...opts,
    startTs: st.cursor_timestamp || opts.startTs || null,
    startId: st.cursor_id || opts.startId || null,
    hooks: {
      savePitId: (pid, pitId) => savePitIdForIndex(pid, indexName, pitId),
      loadPitId: (pid) => loadPitIdForIndex(pid, indexName),
      commitCheckpoint: (pid, cursor, stats) => commitIndexCheckpoint(pid, indexName, cursor, stats),
    },
  });

  // Mark partition idle (or done for date_range)
  const finalStatus = result.fetched === 0 && pipeline.pull_mode === 'date_range' ? 'complete' : 'idle';
  db.prepare(`
    UPDATE pipeline_indexes SET status=?, last_run_at=datetime('now'), last_error=NULL
    WHERE pipeline_id=? AND index_name=?
  `).run(finalStatus, pipeline.id, indexName);

  return result;
}

/**
 * Run a scheduled pull: fetch all docs in a time window using N parallel sliced scroll workers.
 *
 * Window selection (no-gap guarantee):
 *   - "to"   = now (always)
 *   - "from" = cursor_timestamp from last successful run  (prevents gaps when cron fires late)
 *              → falls back to now − lookback_hours on first ever run
 *   opts.forceFrom overrides the cursor (e.g. for a manual "run now" with a specific window).
 *
 * Deduplication via event_id hash prevents duplicate inserts when windows overlap.
 * cursor_timestamp is only written after ALL slices complete — a partial failure leaves
 * the cursor at the last good point so the next trigger re-covers the missed range.
 *
 * Returns { fetched, inserted, skipped, dlq, from, to }.
 */
async function runScheduledSlices(conn, cluster, pipeline, opts = {}) {
  const db = getDb();
  let dedupWarned = false; // shared across all workers — log the "dedup disabled" warning once per run
  const sliceMax = Math.max(1, Math.min(pipeline.parallel_slices || 1, 10));
  const tsField = pipeline.timestamp_field || '@timestamp';
  const batchSize = Math.min(pipeline.batch_size || 2000, 10000);
  const retryOpts = {
    maxAttempts: (pipeline.retry_count || 5) + 1,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
  };

  // ── Compute time window ──────────────────────────────────────────────────────
  const to = opts.to || new Date();
  let from;
  if (opts.forceFrom) {
    // Manual override (e.g. run-now with an explicit window)
    from = opts.forceFrom instanceof Date ? opts.forceFrom : new Date(opts.forceFrom);
  } else {
    // Use the end of the last successful run as "from" so there are no gaps between runs.
    // Fall back to now − lookback_hours on the very first run.
    const lastRun = db.prepare('SELECT cursor_timestamp FROM pipeline_status WHERE pipeline_id=?').get(pipeline.id);
    const lookbackMs = (pipeline.schedule_lookback_hours || 24) * 3600 * 1000;
    from = lastRun?.cursor_timestamp
      ? new Date(lastRun.cursor_timestamp)
      : new Date(to.getTime() - lookbackMs);
  }

  // ── Build time sub-windows for parallel workers ─────────────────────────────
  // Time-window partitioning works regardless of shard count, unlike OpenSearch
  // slice queries which only help when the index has multiple shards. Each worker
  // scrolls its own non-overlapping time range concurrently.
  const windowMs = to.getTime() - from.getTime();
  const subMs = Math.max(1, Math.floor(windowMs / sliceMax));

  const timeWindows = Array.from({ length: sliceMax }, (_, i) => {
    const wFrom = new Date(from.getTime() + i * subMs);
    if (i === sliceMax - 1) {
      // Last window: inclusive upper bound covering any rounding remainder
      return { gte: wFrom.toISOString(), lte: to.toISOString() };
    }
    // Intermediate windows: exclusive upper bound (lt) avoids boundary duplicates
    return { gte: wFrom.toISOString(), lt: new Date(from.getTime() + (i + 1) * subMs).toISOString() };
  });

  pipelineLog(pipeline.id, 'info',
    `Scheduled pull: ${from.toISOString()} → ${to.toISOString()} · ${sliceMax} time-window worker(s) · batch=${batchSize}`
  );

  const cancelToken = opts.cancelToken || null; // scheduler passes this for pause support

  // ── Per-worker: scrolls its own time sub-window ──────────────────────────────
  async function runWorker(workerId, range) {
    let workerFetched = 0, workerInserted = 0, workerSkipped = 0, workerDlq = 0;
    let batchRows = [];
    // Timing for per-batch throughput. lastFlushAt marks the end of the previous batch
    // cycle so we can measure the full fetch→transform→insert interval for this one.
    let lastFlushAt = Date.now();

    async function flushBatch() {
      if (!batchRows.length) return;
      const eventIds = batchRows.map(r => r.event_id).filter(Boolean);
      let insertRows = batchRows;
      if (eventIds.length > 0) {
        try {
          const existing = await ch.getExistingEventIds(
            cluster, pipeline.clickhouse_database, pipeline.clickhouse_table, eventIds
          );
          if (existing.length > 0) {
            const existingSet = new Set(existing);
            insertRows = batchRows.filter(r => !r.event_id || !existingSet.has(r.event_id));
            workerSkipped += batchRows.length - insertRows.length;
          }
        } catch (e) {
          if (e.dedupUnsupported && !dedupWarned) {
            dedupWarned = true;
            pipelineLog(pipeline.id, 'warn', e.message);
          } else if (!e.dedupUnsupported) {
            throw e;
          }
          // dedup unsupported → fall through and insert without a dedup check
        }
      }
      if (insertRows.length) {
        const ndjson = insertRows.map(r => JSON.stringify(r)).join('\n');
        const insertStart = Date.now();
        await withRetry(
          () => ch.insertRows(cluster, pipeline.clickhouse_database, pipeline.clickhouse_table, ndjson),
          retryOpts
        );
        const now = Date.now();
        workerInserted += insertRows.length;
        metrics.recordIngestion(insertRows.length, Buffer.byteLength(ndjson, 'utf8'));

        // Two rates: cycle = end-to-end throughput (fetch+transform+insert since the last
        // batch); insert = pure ClickHouse write speed for this batch.
        const cycleMs = Math.max(1, now - lastFlushAt);
        const insertMs = Math.max(1, now - insertStart);
        const cycleRate = Math.round(insertRows.length / (cycleMs / 1000));
        const insertRate = Math.round(insertRows.length / (insertMs / 1000));
        lastFlushAt = now;

        pipelineLog(pipeline.id, 'info',
          `[worker-${workerId}] Batch inserted: ${insertRows.length} rows in ${(cycleMs / 1000).toFixed(1)}s ` +
          `(${cycleRate.toLocaleString()} rows/sec · insert ${insertRate.toLocaleString()}/s) ` +
          `(skipped ${workerSkipped} dedup)`
        );
      }
      batchRows = [];
    }

    // sliceId=0, sliceMax=1 → no shard slice block; full index scanned within the time range.
    // Throw a sentinel inside onPage when cancelled so the scroll is abandoned immediately
    // rather than waiting for the full sub-window to complete.
    const CANCELLED = Symbol('cancelled');
    try {
      await os.fetchSlicedWindow(conn, pipeline.index_pattern, 0, 1, batchSize, range, tsField, async (docs) => {
        if (cancelToken?.cancelled) throw CANCELLED;
        workerFetched += docs.length;
        for (const d of docs) {
          try {
            batchRows.push(transformDoc(d, pipeline));
          } catch (e) {
            toDlq(pipeline.id, [d], { message: e.message, category: 'transform' });
            workerDlq++;
          }
          if (batchRows.length >= batchSize) await flushBatch();
        }
      });
    } catch (e) {
      if (e !== CANCELLED) throw e; // only swallow the cancellation sentinel
    }

    await flushBatch();
    return { fetched: workerFetched, inserted: workerInserted, skipped: workerSkipped, dlq: workerDlq };
  }

  // ── Run all time-window workers in parallel ───────────────────────────────────
  const results = await Promise.all(
    timeWindows.map((range, i) => runWorker(i, range))
  );

  const totals = results.reduce(
    (acc, r) => ({ fetched: acc.fetched + r.fetched, inserted: acc.inserted + r.inserted, skipped: acc.skipped + r.skipped, dlq: acc.dlq + r.dlq }),
    { fetched: 0, inserted: 0, skipped: 0, dlq: 0 }
  );

  pipelineLog(pipeline.id, 'info',
    `Scheduled run complete — fetched ${totals.fetched}, inserted ${totals.inserted}, skipped ${totals.skipped} (dedup), dlq ${totals.dlq} · ${sliceMax} worker(s)`
  );

  // ── Persist checkpoint ONLY after all slices succeed ────────────────────────
  // Writing cursor_timestamp = to means the next run will start from here — no gaps.
  // A partial failure (exception above) skips this block, so next trigger re-covers the range.
  db.prepare(`
    INSERT INTO pipeline_status
      (pipeline_id, cursor_timestamp, rows_inserted_total, rows_inserted_today, rows_skipped_dedup, rows_dlq, last_success_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(pipeline_id) DO UPDATE SET
      cursor_timestamp    = excluded.cursor_timestamp,
      rows_inserted_total = COALESCE(pipeline_status.rows_inserted_total, 0) + ?,
      rows_inserted_today = COALESCE(pipeline_status.rows_inserted_today, 0) + ?,
      rows_skipped_dedup  = COALESCE(pipeline_status.rows_skipped_dedup, 0) + ?,
      rows_dlq            = COALESCE(pipeline_status.rows_dlq, 0) + ?,
      last_success_at     = datetime('now'),
      updated_at          = datetime('now')
  `).run(
    pipeline.id, to.toISOString(),
    totals.inserted, totals.inserted, totals.skipped, totals.dlq,
    totals.inserted, totals.inserted, totals.skipped, totals.dlq
  );

  return { ...totals, from, to };
}

module.exports = { runPipelineOnce, runIndexPartition, runScheduledSlices, transformDoc, buildRange };
