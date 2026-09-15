const crypto = require('crypto');
const os = require('./services/opensearch');
const ch = require('./services/clickhouse');
const { getDb } = require('./db');
const { withRetry, sleep } = require('./retry');
const metrics = require('./services/metrics');
const progress = require('./progress');
const WorkerPool = require('./workerPool');

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

// ── Per-run history helpers ───────────────────────────────────────────────────

function startRunRecord(pipelineId, startedAt) {
  try {
    const r = getDb().prepare(
      "INSERT INTO pipeline_runs (pipeline_id, started_at, status) VALUES (?, ?, 'running')"
    ).run(pipelineId, startedAt);
    return r.lastInsertRowid;
  } catch { return null; }
}

function finishRunRecord(runId, { finishedAt, status, fromTs, toTs, fetched, inserted, skipped, dlq, errorMsg }) {
  if (!runId) return;
  try {
    getDb().prepare(`
      UPDATE pipeline_runs SET
        finished_at=?, status=?, from_ts=?, to_ts=?,
        fetched=?, inserted=?, skipped=?, dlq=?, error_msg=?
      WHERE id=?
    `).run(finishedAt, status, fromTs, toTs, fetched || 0, inserted || 0, skipped || 0, dlq || 0, errorMsg || null, runId);
  } catch {}
}

// Compute reconciliation for the run's exact window and save as an immutable snapshot.
// Called async after cursor advance — never blocks the run completion path.
async function saveRunReconciliation(runId, pipeline, conn, cluster, fromTs, toTs) {
  if (!runId) return;
  try {
    const tsField = pipeline.timestamp_field || '@timestamp';
    let indexList;
    try { indexList = JSON.parse(pipeline.index_set_filter || '[]'); } catch { indexList = []; }
    const target = indexList.length ? indexList.join(',') : pipeline.index_pattern;

    const range = {};
    if (fromTs) range.gte = fromTs;
    if (toTs) range.lte = toTs;

    const [source, dest] = await Promise.allSettled([
      os.getRangeStats(conn, target, range, tsField),
      (async () => {
        const parts = [];
        if (fromTs) parts.push(`timestamp >= '${fromTs.replace('T', ' ').replace(/Z$/, '')}'`);
        if (toTs)   parts.push(`timestamp <= '${toTs.replace('T', ' ').replace(/Z$/, '')}'`);
        return ch.getRangeStats(cluster, pipeline.clickhouse_database, pipeline.clickhouse_table, parts.join(' AND '));
      })(),
    ]);

    const srcCount  = source.status  === 'fulfilled' ? (source.value?.count  ?? null) : null;
    const destCount = dest.status    === 'fulfilled' ? (dest.value?.count    ?? null) : null;
    const remaining = (srcCount !== null && destCount !== null) ? Math.max(0, srcCount - destCount) : null;
    const successPct = (srcCount !== null && destCount !== null && srcCount > 0)
      ? Math.round((Math.min(destCount, srcCount) / srcCount) * 1000) / 10
      : (srcCount === 0 ? 100 : null);

    getDb().prepare(`
      INSERT OR REPLACE INTO pipeline_run_reconciliation
        (run_id, source_count, destination_count, remaining, success_pct, reconciled_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(runId, srcCount, destCount, remaining, successPct, new Date().toISOString());
  } catch (e) {
    // Reconciliation failure must never crash the run — just log it.
    try { pipelineLog(pipeline.id, 'warn', `Run #${runId} reconciliation failed: ${e.message}`); } catch {}
  }
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
    // FortiGate also emits "N/A" for absent numeric fields (srcport, dstport, sentbyte
    // on subtype:system logs); feeding that to a UInt column throws Code 27 and kills the
    // whole batch, so treat it as empty too. raw_data still keeps the original value.
    if (val === undefined || val === null || val === '' || val === 'N/A') continue;
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

// Date-range windows are picked at minute granularity in the UI. OpenSearch rounds a
// minute-precision `lte` bound (e.g. "…T23:59") UP to the end of that minute
// (23:59:59.999), so reconciliation counts the whole final minute. The ingestion chunker,
// however, parses the same value with new Date() to an exact instant (23:59:00.000) and
// uses it as an EXCLUSIVE upper bound — silently dropping 23:59:00.001–23:59:59.999
// (~one minute of events). Advance the window end to the START OF THE NEXT MINUTE so the
// selected final minute is fully included and ingestion matches reconciliation.
function dateRangeEndExclusive(d) {
  return new Date(Math.floor(d.getTime() / 60000) * 60000 + 60000);
}

// Build the OpenSearch time-range filter from the pipeline's pull mode.
function buildRange(pipeline) {
  const range = {};
  if (pipeline.pull_mode === 'from_date' && pipeline.pull_from_date) {
    range.gte = pipeline.pull_from_date;
  } else if (pipeline.pull_mode === 'date_range') {
    if (pipeline.pull_from_date) range.gte = pipeline.pull_from_date;
    // Exclusive next-minute upper bound so the selected final minute is not truncated.
    if (pipeline.pull_to_date) range.lt = dateRangeEndExclusive(new Date(pipeline.pull_to_date)).toISOString();
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
      let dedupCheckFailed = false;
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
          if (e.dedupUnsupported) {
            // No event_id column — dedup is impossible for this pipeline. There is no key
            // to dedup on, so inserting is unavoidable; surfaced loudly, warned once.
            if (!dedupWarned) { dedupWarned = true; pipelineLog(pipeline.id, 'warn', e.message); }
          } else if (e.dedupFallback) {
            // Dedup CHECK failed after retries (ClickHouse overloaded/unreachable).
            // Never insert without a dedup check — that silently reintroduces duplicates.
            // Route the whole batch to the DLQ instead (preserved for reprocessing).
            dedupCheckFailed = true;
            if (!dedupWarned) { dedupWarned = true; pipelineLog(pipeline.id, 'warn', e.message); }
          } else {
            throw e;
          }
        }
      }

      // Dedup check failed → DLQ the raw batch, insert nothing (no blind insert = no duplicates).
      if (dedupCheckFailed) {
        toDlq(pipeline.id, accumDocs, { message: 'dedup check failed — batch routed to DLQ to avoid inserting without dedup', category: 'dedup_check_failed' });
        accumDlq += accumRows.length;
        insertRows = [];
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
// Symbol thrown to unwind a worker immediately when the run is cancelled (pause).
const RUN_CANCELLED = Symbol('run-cancelled');

/**
 * Run a time window with a shared work-queue of small chunks consumed by a pool of
 * worker coroutines (single-process, so "claim" is a synchronous queue.shift() — no
 * locks needed). Fast workers keep pulling more chunks, so a dense region can't leave
 * others idle. A chunk that fails is retried in place, then requeued for another
 * worker; only if it exhausts its redistribution budget is it marked FAILED.
 *
 * Cursor rule (all-or-nothing, per the "one trigger owns one window" requirement):
 * the cursor advances to `to` ONLY when EVERY chunk is COMPLETE. Any permanent failure
 * (or a pause) leaves the cursor untouched so the next trigger re-covers the window.
 * Fetch uses PIT + search_after (one search context per active worker), which avoids
 * the per-shard scroll-context ceiling that scroll-based fetching hit on wide patterns.
 *
 * Returns { fetched, inserted, skipped, dlq, from, to, chunks, complete, failed,
 * cancelled? }. Throws when the window is left incomplete by failures (not by pause),
 * so the scheduler marks the run errored and retries.
 */
async function runScheduledSlices(conn, cluster, pipeline, opts = {}) {
  const db = getDb();
  const runStartMs = Date.now(); // wall-clock run start, for the completion summary
  const runStartedAt = new Date(runStartMs).toISOString();
  const runId = startRunRecord(pipeline.id, runStartedAt);
  let dedupWarned = false; // shared across all workers — log the "dedup disabled" warning once per run
  const workerCount = Math.max(1, Math.min(pipeline.parallel_slices || 1, 10));
  const tsField = pipeline.timestamp_field || '@timestamp';
  const batchSize = Math.min(pipeline.batch_size || 2000, 10000);
  const inPlaceRetries = Math.max(0, pipeline.retry_count ?? 5); // retries by the SAME worker before redistributing
  const MAX_REDISTRIBUTIONS = 2;   // hand a failing chunk to at most this many OTHER workers before giving up
  const OVERSPLIT = 5;             // chunks per worker — enough for fast workers to pick up slack
  const MIN_CHUNK_MS = 60_000;     // don't split finer than 1 minute
  const insertRetryOpts = {
    maxAttempts: (pipeline.retry_count || 5) + 1,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
  };
  const cancelToken = opts.cancelToken || null; // scheduler passes this for pause support

  // ── Max run time (deadline) ──────────────────────────────────────────────────
  // Optional hard cap so a trigger can't run indefinitely. When the deadline passes,
  // workers stop claiming (reusing the cancellation path), in-flight inserts finish,
  // PITs close, and the finalizer throws WINDOW INCOMPLETE — the cursor is NOT advanced
  // and the scheduler's normal auto-restart re-covers the window on the next trigger.
  const maxRunMs = (opts.maxRunMinutes ?? pipeline.max_run_minutes ?? 0) > 0
    ? (opts.maxRunMinutes ?? pipeline.max_run_minutes) * 60_000
    : 0;
  const deadlineAt = maxRunMs ? Date.now() + maxRunMs : 0;
  const deadlineHit = () => deadlineAt !== 0 && Date.now() >= deadlineAt;
  // A pause/shutdown (cancelToken) OR the deadline both stop workers via the same path.
  const stopRequested = () => (cancelToken?.cancelled === true) || deadlineHit();

  // ── Compute time window ──────────────────────────────────────────────────────
  const to = opts.to || new Date();
  let from;
  if (opts.forceFrom) {
    // Manual override (e.g. run-now / date_range with an explicit window)
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

  // ── Index-aware routing: learn each physical index's actual time span ────────
  // A PIT/scroll opens one search context PER SHARD, so opening it on the full pattern
  // (hundreds of daily indices) blows past the 500-context limit. Instead, route each
  // chunk to only the indices whose data time-span overlaps it. Bounds come from the
  // DATA (min/max @timestamp per _index), so this is layout-agnostic: daily-rotated,
  // non-daily, single, or multi-index all work without parsing index names.
  // Falls back to the full pattern if discovery fails (correctness over efficiency).
  let indexBounds = null;
  try {
    indexBounds = await os.getPerIndexTimeBounds(conn, pipeline.index_pattern, tsField);
    if (!indexBounds.length) indexBounds = null; // nothing discovered → fall back
  } catch (e) {
    pipelineLog(pipeline.id, 'warn',
      `Index-aware routing unavailable (${String(e.message).slice(0, 120)}) — falling back to full pattern per chunk.`);
    indexBounds = null;
  }

  // Which physical indices can hold data for [startMs, endMs)? Overlap test on real
  // data bounds. Returns null → caller uses the full pattern (fallback path).
  function indicesForRange(startMs, endMs) {
    if (!indexBounds) return null;
    const hits = indexBounds.filter(b => b.min <= endMs && b.max >= startMs).map(b => b.index);
    return hits; // may be [] → chunk provably has no data
  }

  // ── Build the chunk queue ────────────────────────────────────────────────────
  // Split [from, to) into many small, non-overlapping time chunks (exclusive upper
  // bound `lt`, except the last which is inclusive `lte`). More chunks than workers so
  // fast workers can pick up extra — this is what gives dynamic load balancing.
  const windowMs = Math.max(0, to.getTime() - from.getTime());
  const desired = workerCount * OVERSPLIT;
  const maxByMin = Math.max(1, Math.floor(windowMs / MIN_CHUNK_MS) || 1);
  const chunkCount = Math.max(1, Math.min(desired, maxByMin));
  const chunkMs = Math.max(1, Math.floor(windowMs / chunkCount));

  const chunks = Array.from({ length: chunkCount }, (_, i) => {
    const cFromMs = from.getTime() + i * chunkMs;
    const isLast = i === chunkCount - 1;
    const cEndMs = isLast ? to.getTime() : from.getTime() + (i + 1) * chunkMs;
    return {
      id: i,
      gte: new Date(cFromMs).toISOString(),
      lt:  isLast ? null : new Date(cEndMs).toISOString(),
      lte: isLast ? to.toISOString() : null,
      indices: indicesForRange(cFromMs, cEndMs), // null=full pattern, []=no data, [..]=routed
      state: 'PENDING',            // PENDING → IN_PROGRESS → COMPLETE | FAILED
      redistributions: 0,          // times handed to another worker after exhausting in-place retries
      cursorTs: null, cursorId: null, // durable resume point within the chunk (last flushed row)
      fetched: 0, inserted: 0, skipped: 0, dlq: 0,
    };
  });

  // Diagnostic: max indices any single chunk routes to (proxy for shard fan-out per PIT).
  const maxIdxPerChunk = indexBounds ? Math.max(0, ...chunks.map(c => (c.indices ? c.indices.length : 0))) : null;
  pipelineLog(pipeline.id, 'info',
    `Scheduled pull: ${from.toISOString()} → ${to.toISOString()} · ${workerCount} worker(s) · ${chunkCount} chunk(s) · batch=${batchSize} · PIT` +
    (indexBounds ? ` · index-routed (${indexBounds.length} indices discovered, ≤${maxIdxPerChunk}/chunk)` : ` · full-pattern (routing unavailable)`)
  );

  // ── Live progress (in-memory, for the UI progress view) ──────────────────────
  const prog = {
    pipelineId: pipeline.id,
    running: true,
    startedAt: new Date().toISOString(),
    endedAt: null,
    window: { from: from.toISOString(), to: to.toISOString() },
    workerCount,
    chunkCount: chunks.length,
    indexRouted: !!indexBounds,
    indicesDiscovered: indexBounds ? indexBounds.length : 0,
    maxRunMinutes: maxRunMs ? Math.round(maxRunMs / 60000) : 0,
    chunks, // live reference — snapshot() serializes state on demand
    workers: Array.from({ length: workerCount }, (_, i) => ({
      id: i, status: 'IDLE', current_chunk: null, current_range: null, completed: 0, retries: 0,
    })),
    finalStatus: null,
  };
  progress.start(pipeline.id, prog);

  // ── Worker Thread Pool ────────────────────────────────────────────────────────
  // Each chunk runs in its own OS thread. The main thread coordinates: it submits
  // chunks to the pool and handles SQLite writes (LOG, DLQ, METRICS, PROGRESS)
  // via message callbacks — worker threads have no SQLite access.

  const pool = new WorkerPool(
    workerCount,
    {
      conn,
      cluster,
      pipeline,
      opts: {
        batchSize,
        tsField,
        inPlaceRetries,
        insertRetryOpts,
      },
    },
    {
      pipelineLog: (level, message) => pipelineLog(pipeline.id, level, message),
      toDlq: (docs, err) => toDlq(pipeline.id, docs, err),
      metricsRecord: (inserted, bytes) => metrics.recordIngestion(inserted, bytes),
      onCursorUpdate: (chunkId, cursorTs, cursorId) => {
        // Keep the chunk's durable cursor current so redistribution resumes from
        // the last safely-inserted page, not the start of the chunk.
        const chunk = chunks[chunkId];
        if (chunk) { chunk.cursorTs = cursorTs; chunk.cursorId = cursorId; }
      },
      onProgress: (chunkId, fetched, inserted) => {
        // Display-only: update the worker status label in the UI progress view.
        // Chunk totals are applied only on CHUNK_COMPLETE to avoid double-counting.
        for (const w of prog.workers) {
          if (w.current_chunk === chunkId) { w.status = 'PROCESSING'; }
        }
      },
    }
  );

  // Stop the pool when a pause/deadline is requested.
  const stopWatcher = setInterval(() => {
    if (stopRequested()) pool.requestStop();
  }, 200);

  // Submit all chunks and collect results. The pool queues excess chunks until
  // a thread frees up — no busy-waiting or polling needed.
  const chunkPromises = chunks.map((chunk, i) => {
    const w = prog.workers[i % workerCount];
    chunk.state = 'IN_PROGRESS';
    w.current_chunk = chunk.id;
    w.current_range = { gte: chunk.gte, end: chunk.lt || chunk.lte };
    w.status = 'PROCESSING';
    return pool.process(chunk).then(({ ok, result, cancelled, failed }) => {
      if (cancelled) {
        // Leave chunk state as-is; finalization detects the cancelled run.
        return;
      }
      if (ok && result) {
        chunk.state   = 'COMPLETE';
        chunk.fetched  += result.fetched;
        chunk.inserted += result.inserted;
        chunk.skipped  += result.skipped;
        chunk.dlq      += result.dlq;
        w.completed++;
        w.status = 'IDLE';
        w.current_chunk = null;
      } else {
        // Failed after all in-place retries — try redistribution.
        if (chunk.redistributions < MAX_REDISTRIBUTIONS) {
          chunk.redistributions++;
          chunk.state = 'PENDING';
          pipelineLog(pipeline.id, 'warn',
            `chunk ${chunk.id} requeued for redistribution (${chunk.redistributions}/${MAX_REDISTRIBUTIONS})`);
          return pool.process(chunk).then(({ ok: ok2, result: r2 }) => {
            if (ok2 && r2) {
              chunk.state    = 'COMPLETE';
              chunk.fetched  += r2.fetched;
              chunk.inserted += r2.inserted;
              chunk.skipped  += r2.skipped;
              chunk.dlq      += r2.dlq;
              w.completed++;
            } else {
              chunk.state = 'FAILED';
              pipelineLog(pipeline.id, 'error',
                `chunk ${chunk.id} [${chunk.gte} → ${chunk.lt || chunk.lte}] FAILED permanently after redistribution`);
            }
            w.status = 'IDLE'; w.current_chunk = null;
          });
        } else {
          chunk.state = 'FAILED';
          pipelineLog(pipeline.id, 'error',
            `chunk ${chunk.id} [${chunk.gte} → ${chunk.lt || chunk.lte}] FAILED permanently after ${chunk.redistributions} redistribution(s)`);
          w.status = 'IDLE'; w.current_chunk = null;
        }
      }
    });
  });

  await Promise.all(chunkPromises);
  clearInterval(stopWatcher);
  await pool.terminate();

  // ── Centralized finalization: inspect EVERY chunk, then decide on the cursor ──
  const totals = chunks.reduce(
    (a, c) => ({ fetched: a.fetched + c.fetched, inserted: a.inserted + c.inserted, skipped: a.skipped + c.skipped, dlq: a.dlq + c.dlq }),
    { fetched: 0, inserted: 0, skipped: 0, dlq: 0 }
  );
  const completeCount = chunks.filter(c => c.state === 'COMPLETE').length;
  const failed = chunks.filter(c => c.state !== 'COMPLETE');

  // Mark the live progress terminal so the UI shows the final outcome.
  const finalizeProgress = (status) => {
    prog.running = false;
    prog.endedAt = new Date().toISOString();
    prog.finalStatus = status;
    for (const w of prog.workers) { w.status = 'COMPLETED'; w.current_chunk = null; w.current_range = null; }
  };

  // Pause: never advance the cursor on a cancelled run — the window is not finished.
  if (cancelToken?.cancelled) {
    finalizeProgress('CANCELLED');
    finishRunRecord(runId, { finishedAt: new Date().toISOString(), status: 'cancelled', fromTs: from.toISOString(), toTs: to.toISOString(), ...totals });
    pipelineLog(pipeline.id, 'warn',
      `Run paused — ${completeCount}/${chunks.length} chunk(s) complete. Cursor NOT advanced; next run re-covers [${from.toISOString()} → ${to.toISOString()}].`);
    return { ...totals, from, to, chunks: chunks.length, complete: completeCount, failed: failed.length, cancelled: true };
  }

  // Incomplete: either a chunk failed after all retries/redistributions, OR the max run
  // time was reached with chunks still outstanding. Either way, do NOT advance the cursor;
  // throw so the scheduler marks the run errored and re-covers the window on the next
  // trigger (already-ingested chunks are dedup-skipped). Completion wins over the deadline:
  // if every chunk finished (failed.length === 0) we fall through to the cursor advance
  // below even when the deadline elapsed at the very end.
  if (failed.length > 0) {
    if (deadlineHit()) {
      finalizeProgress('INCOMPLETE');
      finishRunRecord(runId, { finishedAt: new Date().toISOString(), status: 'failed', fromTs: from.toISOString(), toTs: to.toISOString(), ...totals, errorMsg: `Max run time reached (${completeCount}/${chunks.length} chunks complete)` });
      pipelineLog(pipeline.id, 'warn',
        `Run stopped — max run time (${Math.round(maxRunMs / 60000)} min) reached with ${completeCount}/${chunks.length} chunk(s) complete. ` +
        `Cursor NOT advanced; next trigger re-covers [${from.toISOString()} → ${to.toISOString()}] and dedup-skips what already landed.`);
      throw new Error(`Scheduled window incomplete: max run time reached (${completeCount}/${chunks.length} chunks complete)`);
    }
    finalizeProgress('FAILED');
    finishRunRecord(runId, { finishedAt: new Date().toISOString(), status: 'failed', fromTs: from.toISOString(), toTs: to.toISOString(), ...totals, errorMsg: `${failed.length}/${chunks.length} chunks failed after retries` });
    pipelineLog(pipeline.id, 'error',
      `Scheduled window INCOMPLETE — ${completeCount}/${chunks.length} chunk(s) complete, ${failed.length} failed. ` +
      `Cursor NOT advanced; next trigger re-covers [${from.toISOString()} → ${to.toISOString()}].`);
    throw new Error(`Scheduled window incomplete: ${failed.length}/${chunks.length} chunk(s) failed after retries`);
  }

  // ── All chunks COMPLETE → advance the cursor to `to` (all-or-nothing) ─────────
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

  finalizeProgress('COMPLETE');

  const endMs = Date.now();
  finishRunRecord(runId, { finishedAt: new Date(endMs).toISOString(), status: 'complete', fromTs: from.toISOString(), toTs: to.toISOString(), ...totals });
  // Fire reconciliation async — never blocks run completion.
  if (pipeline.clickhouse_table && pipeline.clickhouse_database) {
    setImmediate(() => saveRunReconciliation(runId, pipeline, conn, cluster, from.toISOString(), to.toISOString()));
  }

  // ── Detailed completion summary: wall-clock start/end, duration, avg speed ────
  const durationSec = Math.max(0.001, (endMs - runStartMs) / 1000);
  const fmtDur = (s) => s < 60 ? `${s.toFixed(1)}s`
    : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
    : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  const avgRate = Math.round(totals.inserted / durationSec);
  pipelineLog(pipeline.id, 'info',
    `Scheduled run complete — window fully ingested [${from.toISOString()} → ${to.toISOString()}] · ` +
    `fetched ${totals.fetched}, inserted ${totals.inserted}, skipped ${totals.skipped} (dedup), dlq ${totals.dlq} · ` +
    `${chunks.length} chunk(s) · ${workerCount} worker(s). Cursor advanced.`
  );
  pipelineLog(pipeline.id, 'info',
    `Ingestion summary — started ${new Date(runStartMs).toISOString()}, ended ${new Date(endMs).toISOString()}, ` +
    `duration ${fmtDur(durationSec)} · inserted ${totals.inserted.toLocaleString()} rows at avg ${avgRate.toLocaleString()} rows/sec ` +
    `(${(totals.inserted / durationSec / 1000).toFixed(1)}k/s) across ${workerCount} worker(s), ${chunks.length} chunk(s).`
  );

  return { ...totals, from, to, chunks: chunks.length, complete: completeCount, failed: 0,
    startedAt: new Date(runStartMs).toISOString(), endedAt: new Date(endMs).toISOString(),
    durationSec: Math.round(durationSec), avgRowsPerSec: avgRate };
}

module.exports = { runPipelineOnce, runIndexPartition, runScheduledSlices, transformDoc, buildRange, dateRangeEndExclusive };
