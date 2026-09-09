/**
 * Production-grade pipeline scheduler.
 *
 * Responsibilities:
 * - On startup: load all active pipelines from SQLite and begin execution
 * - Per-pipeline execution lock: a pipeline never runs concurrently with itself
 * - Multiple pipelines can run concurrently with each other
 * - Continuous mode: keep polling after catching up (respects poll_interval_secs)
 * - Historical/date-range mode: stop when range is exhausted, mark idle
 * - Graceful shutdown: signal running pipelines, wait for current batch to finish
 * - Restart recovery: on startup, active pipelines are automatically resumed
 *
 * The scheduler does NOT use setInterval per pipeline. Instead:
 * - A global tick runs every TICK_MS to check which pipelines are due
 * - Each pipeline tracks its own nextRunAt in the in-process Map
 * - Execution happens in an async loop per pipeline, completely independent
 */

'use strict';

const { getDb } = require('./db');
const runner = require('./runner');
const { decryptRow } = require('./crypto');

const TICK_MS = 3000; // how often the scheduler checks for due pipelines

// In-process state — not persisted (intentionally, this is just a runtime lock)
const executionTokens = new Map(); // pipelineId -> { cancelled: bool }
const nextRunAt = new Map();       // pipelineId -> Date (when to next poll)

let tickTimer = null;
let shuttingDown = false;

// ── Public API ────────────────────────────────────────────────────────────────

/** Reset rows_inserted_today to 0 for all pipelines. Called at midnight. */
function resetDailyCounters() {
  try {
    getDb().prepare('UPDATE pipeline_status SET rows_inserted_today = 0').run();
    console.log('[scheduler] daily counters reset (rows_inserted_today = 0)');
  } catch (e) {
    console.warn('[scheduler] daily counter reset failed:', e.message);
  }
}

/** Schedule the next midnight reset, then repeat daily. */
function scheduleMidnightReset() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0); // next midnight local time
  const msUntilMidnight = next.getTime() - now.getTime();
  setTimeout(() => {
    resetDailyCounters();
    setInterval(resetDailyCounters, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
  console.log(`[scheduler] daily reset scheduled in ${Math.round(msUntilMidnight / 60000)}m`);
}

/** Start the scheduler. Call once from index.js after DB init. */
function start() {
  shuttingDown = false;
  tick(); // immediate first tick picks up any pipelines that were active before restart
  tickTimer = setInterval(tick, TICK_MS);
  scheduleMidnightReset();
  console.log('[scheduler] started — polling every', TICK_MS, 'ms');
}

/**
 * Gracefully shut down.
 * Signals all running pipelines, waits up to `timeoutMs` for them to stop,
 * then returns (caller should then close DB and exit).
 */
async function shutdown(timeoutMs = 30000) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }

  const running = [...executionTokens.keys()];
  if (running.length > 0) {
    console.log(`[scheduler] shutdown: cancelling ${running.length} pipeline(s)…`);
    for (const id of running) cancel(id);

    const deadline = Date.now() + timeoutMs;
    while (executionTokens.size > 0 && Date.now() < deadline) {
      await delay(200);
    }
    if (executionTokens.size > 0) {
      console.warn(`[scheduler] ${executionTokens.size} pipeline(s) did not stop within ${timeoutMs}ms`);
    }
  }
  console.log('[scheduler] shutdown complete');
}

/** True if the pipeline has an active execution in this process. */
function isRunning(pipelineId) {
  return executionTokens.has(Number(pipelineId));
}

/**
 * Trigger immediate execution of a pipeline (called by run-now API).
 * Returns { ok, alreadyRunning } without waiting for the run to finish —
 * the caller (route handler) manages its own await if it wants results.
 *
 * Returns false if already running so the API can return a 409.
 */
function triggerNow(pipelineId) {
  const id = Number(pipelineId);
  if (executionTokens.has(id)) return false; // already running
  // Fire async without awaiting — the scheduler owns this lifecycle
  executePipeline(id).catch(e =>
    console.error(`[scheduler] triggerNow pipeline ${id}:`, e.message)
  );
  return true;
}

/**
 * Cancel a running pipeline (called by pause API).
 * Sets the cancel flag; the next safe point in the execution loop will stop.
 */
function cancel(pipelineId) {
  const token = executionTokens.get(Number(pipelineId));
  if (token) token.cancelled = true;
}

/** Export running pipeline IDs (for status endpoints). */
function runningIds() {
  return [...executionTokens.keys()];
}

// ── Scheduler tick ────────────────────────────────────────────────────────────

function tick() {
  if (shuttingDown) return;
  const db = getDb();
  let active;
  try {
    active = db.prepare("SELECT id FROM pipelines WHERE status='active'").all();
  } catch {
    return; // DB not ready yet (startup race)
  }

  const now = Date.now();
  for (const { id } of active) {
    if (executionTokens.has(id)) continue; // already executing
    const due = nextRunAt.get(id);
    if (due && due > now) continue; // waiting for poll interval
    // Launch execution — fire and forget (tracked via executionTokens)
    executePipeline(id).catch(e =>
      console.error(`[scheduler] tick: pipeline ${id} error:`, e.message)
    );
  }
}

// ── Per-pipeline execution loop ───────────────────────────────────────────────

async function executePipeline(pipelineId) {
  const id = Number(pipelineId);
  if (executionTokens.has(id)) return; // guard against double-entry

  const token = { cancelled: false };
  executionTokens.set(id, token);

  try {
    await runLoop(id, token);
  } catch (e) {
    console.error(`[scheduler] pipeline ${id} uncaught:`, e.message);
  } finally {
    executionTokens.delete(id);
    nextRunAt.delete(id);
  }
}

async function runLoop(pipelineId, token) {
  const db = getDb();
  let consecutiveErrors = 0; // tracks auto-restart backoff
  let firstZeroAt = null; // timestamp of first consecutive zero-result pass (date_range exhaustion guard)

  while (!token.cancelled && !shuttingDown) {
    // Re-read pipeline config fresh each iteration (user may have edited it)
    const row = db.prepare(
      "SELECT * FROM pipelines WHERE id = ? AND status = 'active'"
    ).get(pipelineId);

    if (!row) break; // deleted or paused since last tick

    const pipeline = parsePipeline(row);
    const conn = decryptRow(db.prepare(
      'SELECT * FROM opensearch_connections WHERE id = ?'
    ).get(pipeline.opensearch_connection_id));
    const cluster = decryptRow(db.prepare(
      'SELECT * FROM clickhouse_clusters WHERE id = ?'
    ).get(pipeline.clickhouse_cluster_id));

    if (!conn || !cluster) {
      pauseWithError(db, pipelineId, 'Missing connection or cluster — configure before starting');
      break;
    }

    // Mark running in status table
    db.prepare(
      "UPDATE pipeline_status SET status='running', last_run_at=datetime('now') WHERE pipeline_id=?"
    ).run(pipelineId);

    let result;
    try {
      const physicalIndexes = pipeline.index_set_filter; // already parsed array

      if (physicalIndexes && physicalIndexes.length > 0) {
        // Multi-index mode: process each physical index independently (serial)
        let totalFetched = 0, totalInserted = 0, totalDlq = 0;
        for (const indexName of physicalIndexes) {
          if (token.cancelled || shuttingDown) break;
          const ir = await runner.runIndexPartition(conn, cluster, pipeline, indexName, { maxPages: 100 });
          totalFetched += ir.fetched;
          totalInserted += ir.inserted;
          totalDlq += ir.dlq;
        }
        result = { fetched: totalFetched, inserted: totalInserted, dlq: totalDlq };
      } else {
        // Single-pattern mode (original behaviour)
        const st = db.prepare(
          'SELECT cursor_timestamp, cursor_id FROM pipeline_status WHERE pipeline_id = ?'
        ).get(pipelineId) || {};
        result = await runner.runPipelineOnce(conn, cluster, pipeline, {
          startTs: st.cursor_timestamp || null,
          startId: st.cursor_id || null,
          maxPages: 100,
        });
      }
    } catch (err) {
      consecutiveErrors++;
      if (pipeline.pause_on_fail) {
        // User chose "Pause on repeated failure" — stop and wait for manual restart
        pauseWithError(db, pipelineId, `${err.category || 'error'}: ${err.message}`, err.message);
        break;
      }
      // Auto-restart mode: log error, wait with exponential backoff, then retry
      const backoffMs = Math.min(consecutiveErrors * 2 * 60 * 1000, 30 * 60 * 1000); // 2m, 4m, 6m … max 30m
      const backoffLabel = backoffMs >= 60000 ? `${Math.round(backoffMs / 60000)}m` : `${Math.round(backoffMs / 1000)}s`;
      db.prepare("UPDATE pipeline_status SET status='error', last_error=? WHERE pipeline_id=?")
        .run(`${err.category || 'error'}: ${err.message}`, pipelineId);
      db.prepare("INSERT INTO pipeline_logs (pipeline_id, level, message) VALUES (?, 'warn', ?)")
        .run(pipelineId, `Error (attempt ${consecutiveErrors}), auto-restarting in ${backoffLabel}: ${err.message}`);
      console.warn(`[scheduler] pipeline ${pipelineId} error #${consecutiveErrors}, retrying in ${backoffLabel}:`, err.message);
      const ok = await cancellableSleep(backoffMs, token);
      if (!ok) break;
      continue;
    }

    if (token.cancelled || shuttingDown) break;

    consecutiveErrors = 0; // successful run — reset backoff counter
    const caughtUp = result.fetched === 0;

    if (caughtUp && pipeline.pull_mode === 'date_range') {
      const CONFIRM_MS = 5 * 60 * 1000; // 5 minutes of silence = truly exhausted
      const now = Date.now();
      if (!firstZeroAt) {
        // First zero pass — start the silence window, retry after 30s
        firstZeroAt = now;
        db.prepare("INSERT INTO pipeline_logs (pipeline_id, level, message) VALUES (?, 'info', ?)")
          .run(pipelineId, `Zero results — waiting 5 min of silence before concluding range is exhausted`);
        const ok = await cancellableSleep(30_000, token);
        if (!ok) break;
        continue;
      }
      if (now - firstZeroAt < CONFIRM_MS) {
        // Still within the silence window — keep retrying every 30s
        const remainingSecs = Math.round((CONFIRM_MS - (now - firstZeroAt)) / 1000);
        db.prepare("INSERT INTO pipeline_logs (pipeline_id, level, message) VALUES (?, 'info', ?)")
          .run(pipelineId, `Still zero results — ${remainingSecs}s remaining before auto-pause`);
        const ok = await cancellableSleep(30_000, token);
        if (!ok) break;
        continue;
      }
      // 5 full minutes of zero results — truly exhausted. Auto-pause.
      db.prepare("UPDATE pipelines SET status='paused', updated_at=datetime('now') WHERE id=?").run(pipelineId);
      db.prepare("UPDATE pipeline_status SET status='idle', last_success_at=datetime('now') WHERE pipeline_id=?").run(pipelineId);
      db.prepare("INSERT INTO pipeline_logs (pipeline_id, level, message) VALUES (?, 'info', ?)")
        .run(pipelineId, `Historical migration complete — date range exhausted after 5 min of silence. Pipeline auto-paused.`);
      break;
    }
    firstZeroAt = null; // reset whenever we fetch something

    // Update status
    db.prepare(
      "UPDATE pipeline_status SET status='idle', last_success_at=datetime('now'), last_error=NULL WHERE pipeline_id=?"
    ).run(pipelineId);

    if (caughtUp) {
      // Continuous/from_date: wait poll_interval then check for new events
      const pollMs = Math.max(5, (pipeline.poll_interval_secs || 30)) * 1000;
      nextRunAt.set(pipelineId, Date.now() + pollMs);

      // Cancellable sleep
      const ok = await cancellableSleep(pollMs, token);
      if (!ok) break;

      nextRunAt.delete(pipelineId);
    }
    // If not caught up, loop immediately — more pages available
  }

  // Ensure status is not stuck as 'running'
  try {
    const row = db.prepare("SELECT status FROM pipelines WHERE id=?").get(pipelineId);
    if (row?.status === 'active') {
      db.prepare(
        "UPDATE pipeline_status SET status='idle' WHERE pipeline_id=? AND status='running'"
      ).run(pipelineId);
    }
  } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pauseWithError(db, pipelineId, statusMsg, logMsg) {
  const now = new Date().toISOString();
  db.prepare("UPDATE pipelines SET status='paused' WHERE id=?").run(pipelineId);
  db.prepare(
    "UPDATE pipeline_status SET status='error', last_error=?, last_run_at=? WHERE pipeline_id=?"
  ).run(statusMsg, now, pipelineId);
  db.prepare(
    "INSERT INTO pipeline_logs (pipeline_id, level, message) VALUES (?, 'error', ?)"
  ).run(pipelineId, logMsg || statusMsg);
}

function parsePipeline(row) {
  try { row.field_mappings = JSON.parse(row.field_mappings || '[]'); } catch { row.field_mappings = []; }
  try { row.index_set_filter = JSON.parse(row.index_set_filter || '[]'); } catch { row.index_set_filter = []; }
  try { row.excluded_fields = JSON.parse(row.excluded_fields || '[]'); } catch { row.excluded_fields = []; }
  return row;
}

/** Sleep for `ms` milliseconds. Returns true if completed, false if cancelled. */
function cancellableSleep(ms, token) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => { done = true; resolve(true); }, ms);
    const check = setInterval(() => {
      if (done) { clearInterval(check); return; }
      if (token.cancelled || shuttingDown) {
        clearTimeout(timer);
        clearInterval(check);
        resolve(false);
      }
    }, 100);
  });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { start, shutdown, isRunning, triggerNow, cancel, runningIds };
