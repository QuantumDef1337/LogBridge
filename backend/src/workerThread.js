'use strict';

/**
 * LogBridge V2 — Worker Thread entry point.
 *
 * Each instance runs in its own OS thread (via Node.js worker_threads).
 * It receives chunk assignments from the main thread, runs the full
 * OpenSearch fetch → transform → ClickHouse insert cycle independently,
 * and posts results/logs/DLQ entries back via parentPort messages.
 *
 * No SQLite access here — all DB writes are handled by the main thread
 * via LOG, DLQ, and CHUNK_COMPLETE messages.
 */

const { workerData, parentPort } = require('worker_threads');
const fetch = require('node-fetch');
const crypto = require('crypto');
const https = require('https');

// ── Helpers duplicated from services (threads cannot share module state) ───────

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function makeAgent(conn) {
  return conn.url.startsWith('https') && !conn.tls_verify ? insecureAgent : undefined;
}

function osAuth(conn) {
  return 'Basic ' + Buffer.from(`${conn.username}:${conn.password}`).toString('base64');
}

function chAuth(cluster) {
  if (!cluster.password) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${cluster.username}:${cluster.password}`).toString('base64') };
}

// ── Retry ─────────────────────────────────────────────────────────────────────

function classifyError(err) {
  const msg = (err?.message ?? String(err)).toLowerCase();
  const transient = ['etimedout','econnreset','econnrefused','esockettimedout','socket hang up','network','timeout','eai_again','enotfound'];
  if (transient.some(s => msg.includes(s))) return { retryable: true, category: 'network' };
  const m = msg.match(/\b(4\d\d|5\d\d)\b/);
  if (m) {
    const code = parseInt(m[1], 10);
    if ([429,500,502,503,504].includes(code)) return { retryable: true,  category: 'server' };
    if ([401,403].includes(code))             return { retryable: false, category: 'auth' };
    if ([400,404,409,422].includes(code))     return { retryable: false, category: 'data' };
  }
  if (msg.includes('circuit_breaking_exception') || msg.includes('data too large')) return { retryable: false, category: 'circuit_breaker' };
  if (msg.includes('cannot parse') || msg.includes('type_mismatch') || msg.includes('unknown identifier')) return { retryable: false, category: 'data' };
  return { retryable: true, category: 'unknown' };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 5;
  const initial     = opts.initialDelayMs ?? 1000;
  const max         = opts.maxDelayMs ?? 30000;
  let attempt = 0;
  while (true) {
    attempt++;
    try { return await fn(); }
    catch (err) {
      const { retryable, category } = classifyError(err);
      err.category = category;
      if (!retryable || attempt >= maxAttempts) { err.attempts = attempt; throw err; }
      const base  = Math.min(initial * Math.pow(2, attempt - 1), max);
      const delay = Math.round(base + base * 0.3 * Math.random());
      await sleep(delay);
    }
  }
}

// ── PIT semaphore helpers ─────────────────────────────────────────────────────
// Prevents all threads from opening PITs simultaneously, which would exceed
// OpenSearch's max_open_scroll_context limit and cause 429 rejections.

async function acquirePitSlot() {
  const sem = workerData.pitSem;
  if (!sem) return; // no semaphore configured — proceed without throttling
  while (true) {
    const cur = Atomics.load(sem, 0);
    if (cur > 0 && Atomics.compareExchange(sem, 0, cur, cur - 1) === cur) return;
    await sleep(100 + Math.random() * 100); // brief wait + jitter before retry
  }
}

function releasePitSlot() {
  const sem = workerData.pitSem;
  if (sem) Atomics.add(sem, 0, 1);
}

// ── OpenSearch helpers ────────────────────────────────────────────────────────

async function openPit(conn, indexPattern, keepAlive = '5m') {
  const res = await fetch(`${conn.url}/${indexPattern}/_search/point_in_time?keep_alive=${keepAlive}`, {
    method: 'POST',
    headers: { Authorization: osAuth(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`OpenSearch PIT open error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const pitId = body.pit_id || body.id;
  if (!pitId) throw new Error('OpenSearch PIT open returned no pit_id');
  return pitId;
}

async function closePit(conn, pitId) {
  if (!pitId) return;
  await fetch(`${conn.url}/_search/point_in_time`, {
    method: 'DELETE',
    headers: { Authorization: osAuth(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    body: JSON.stringify({ pit_id: pitId }),
    timeout: 10000,
  }).catch(() => {});
}

async function fetchPage(conn, pitId, pageSize, cursorTs, cursorId, range, tsField) {
  const body = {
    size: pageSize,
    track_total_hits: false,
    sort: [{ [tsField]: 'asc' }, { _id: 'asc' }],
    pit: { id: pitId, keep_alive: '5m' },
    // Tell OpenSearch how to parse the range boundary values (ISO from the chunker) so it
    // does not fall back to the field's own mapping format. Required for Graylog-style
    // `timestamp` fields stored as "yyyy-MM-dd HH:mm:ss.SSS" (no T/Z), which otherwise
    // reject the ISO boundaries with a parse_exception. Mirrors services/opensearch.js.
    query: { range: { [tsField]: { ...range, format: 'strict_date_optional_time||yyyy-MM-dd HH:mm:ss.SSS||yyyy-MM-dd' } } },
  };
  if (cursorTs != null) body.search_after = [cursorTs, cursorId ?? ''];

  const res = await fetch(`${conn.url}/_search`, {
    method: 'POST',
    headers: { Authorization: osAuth(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    body: JSON.stringify(body),
    timeout: 60000,
  });
  if (!res.ok) {
    const text = await res.text();
    const err  = new Error(`OpenSearch search error ${res.status}: ${text}`);
    if (res.status === 404 && text.includes('search_context_missing')) err.pitExpired = true;
    throw err;
  }
  const data = await res.json();
  const docs  = (data.hits?.hits ?? []).map(h => ({ ...h._source, _id: h._id, _index: h._index, _sort: h.sort }));
  const newPitId = data.pit_id || pitId;
  let nextCursor = { ts: null, id: null };
  if (docs.length > 0) {
    const last = data.hits.hits[data.hits.hits.length - 1];
    nextCursor = { ts: last.sort?.[0] ?? null, id: last.sort?.[1] ?? null };
  }
  return { docs, pitId: newPitId, nextCursor };
}

// ── ClickHouse helpers ────────────────────────────────────────────────────────

async function chQuery(cluster, sql) {
  const url = `${cluster.url}/?query=${encodeURIComponent(sql + ' FORMAT JSON')}`;
  const res  = await fetch(url, { headers: chAuth(cluster), timeout: 15000 });
  if (!res.ok) throw new Error(`ClickHouse error ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function chInsert(cluster, database, table, ndjson) {
  const sql = `INSERT INTO \`${database}\`.\`${table}\` FORMAT JSONEachRow`;
  const url  = `${cluster.url}/?query=${encodeURIComponent(sql)}&input_format_skip_unknown_fields=1&date_time_input_format=best_effort`;
  const res  = await fetch(url, {
    method: 'POST',
    headers: { ...chAuth(cluster), 'Content-Type': 'application/x-ndjson' },
    body: ndjson,
    timeout: 120000,
  });
  if (!res.ok) throw new Error(`ClickHouse insert error ${res.status}: ${await res.text()}`);
  return true;
}

async function getExistingEventIds(cluster, database, table, eventIds) {
  if (!eventIds.length) return [];
  // Chunk into 1000-ID batches — a full 10k-ID IN-list serializes to ~500 KB and
  // triggers ClickHouse Poco::Exception Code 1000 (HTML error page instead of JSON).
  const CHUNK = 1000;
  if (eventIds.length > CHUNK) {
    const results = [];
    for (let i = 0; i < eventIds.length; i += CHUNK) {
      const partial = await getExistingEventIds(cluster, database, table, eventIds.slice(i, i + CHUNK));
      results.push(...partial);
    }
    return results;
  }
  const inList = eventIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
  const sql    = `SELECT event_id FROM \`${database}\`.\`${table}\` WHERE event_id IN (${inList})`;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await chQuery(cluster, sql);
      return (res.data || []).map(r => r.event_id);
    } catch (e) {
      if (/UNKNOWN_IDENTIFIER|Code:\s*47\b/.test(e.message) && /event_id/.test(e.message)) {
        const err = new Error(`Target table \`${database}\`.\`${table}\` has no 'event_id' column — deduplication DISABLED.`);
        err.dedupUnsupported = true;
        throw err;
      }
      lastErr = e;
      if (attempt < 4) await sleep(Math.min(500 * 2 ** attempt, 8000));
    }
  }
  const err = new Error(`dedup check failed after 5 attempts (${lastErr?.message?.slice(0, 80)}) — routing batch to DLQ (not inserting without dedup)`);
  err.dedupFallback = true;
  throw err;
}

// ── Transform ─────────────────────────────────────────────────────────────────

function getNested(doc, path) {
  if (!path) return undefined;
  let cur = doc;
  for (const p of path.split('.')) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

function hash(algo, str) {
  return crypto.createHash(algo === 'sha256' ? 'sha256' : 'md5').update(str).digest('hex');
}

function deleteNestedPath(obj, parts) {
  if (!obj || typeof obj !== 'object' || !parts.length) return obj;
  const copy = { ...obj };
  if (parts.length === 1) { delete copy[parts[0]]; return copy; }
  if (parts[0] in copy) copy[parts[0]] = deleteNestedPath(copy[parts[0]], parts.slice(1));
  return copy;
}

function applyExclusions(doc, excludedFields) {
  const topLevel = new Set();
  const nested   = [];
  for (const f of excludedFields) {
    const dot = f.indexOf('.');
    if (dot === -1) topLevel.add(f); else nested.push(f.split('.'));
  }
  let result = topLevel.size > 0
    ? Object.fromEntries(Object.entries(doc).filter(([k]) => !topLevel.has(k)))
    : { ...doc };
  for (const parts of nested) result = deleteNestedPath(result, parts);
  return result;
}

function transformDoc(doc, pipeline) {
  const row = {};
  for (const m of pipeline.field_mappings || []) {
    if (!m.dest) continue;
    let val;
    switch (m.source_type) {
      case 'field':    val = getNested(doc, m.source_value); break;
      case 'static':   val = m.source_value; break;
      case 'full_doc': {
        const excl = Array.isArray(pipeline.excluded_fields) ? pipeline.excluded_fields : [];
        val = JSON.stringify(excl.length > 0 ? applyExclusions(doc, excl) : doc);
        break;
      }
      case 'now': val = new Date().toISOString(); break;
      case 'md5': val = hash('md5', String(getNested(doc, m.source_value) ?? '')); break;
      default:    val = null;
    }
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) val = JSON.stringify(val);
    // FortiGate emits "N/A" as a placeholder for absent numeric fields (e.g. srcport,
    // dstport, sentbyte on subtype:system event logs). Feeding "N/A" to a UInt/DateTime
    // column throws Code 27 CANNOT_PARSE and kills the whole JSONEachRow batch. Treat it
    // as empty so the column's default applies; raw_data still keeps the original value.
    if (val === undefined || val === null || val === '' || val === 'N/A') continue;
    row[m.dest] = val;
  }

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

  if (pipeline.dedup_enabled && row.event_id === undefined) {
    const src = getNested(doc, pipeline.dedup_field);
    let asStr = src !== null && src !== undefined && typeof src === 'object' ? JSON.stringify(src) : (src ?? '');
    if (asStr === '') asStr = JSON.stringify(doc);
    row.event_id = hash(pipeline.dedup_algo, String(asStr));
  }

  return row;
}

// ── Messaging helpers ─────────────────────────────────────────────────────────

function log(level, message) {
  parentPort.postMessage({ type: 'LOG', level, message });
}

function dlq(docs, err) {
  parentPort.postMessage({ type: 'DLQ', docs, error: { message: (err?.message ?? String(err)).slice(0, 2000), category: err?.category || 'unknown', attempts: err?.attempts || 0 } });
}

function progress(chunkId, fetched, inserted) {
  parentPort.postMessage({ type: 'PROGRESS', chunkId, fetched, inserted });
}

// ── Core: ingest one chunk ────────────────────────────────────────────────────

async function ingestChunk(chunk, pipeline, conn, cluster, opts) {
  const { workerId, batchSize, insertRetryOpts, tsField } = opts;
  const range = { gte: chunk.gte };
  if (chunk.lt) range.lt = chunk.lt; else range.lte = chunk.lte;

  // Index-aware: empty array means provably no data in this chunk's window.
  if (Array.isArray(chunk.indices) && chunk.indices.length === 0) return { fetched: 0, inserted: 0, skipped: 0, dlq: 0 };
  const target = Array.isArray(chunk.indices) && chunk.indices.length
    ? chunk.indices.join(',')
    : pipeline.index_pattern;

  await acquirePitSlot();
  let pitId;
  try {
    pitId = await openPit(conn, target);
  } finally {
    releasePitSlot();
  }
  let fetched = 0, inserted = 0, skipped = 0, dlqCount = 0;
  let dedupFallbackLogged = false;

  try {
    let cursorTs = chunk.cursorTs || null;
    let cursorId = chunk.cursorId || null;

    while (true) {
      // Check stop signal from main thread
      if (Atomics.load(workerData.stopFlag, 0) === 1) throw new Error('RUN_CANCELLED');

      const cycleStart = Date.now();
      let page;
      try {
        page = await fetchPage(conn, pitId, batchSize, cursorTs, cursorId, range, tsField);
      } catch (e) {
        if (e.pitExpired) {
          await closePit(conn, pitId).catch(() => {});
          await acquirePitSlot();
          try { pitId = await openPit(conn, target); } finally { releasePitSlot(); }
          page = await fetchPage(conn, pitId, batchSize, cursorTs, cursorId, range, tsField);
        } else {
          throw e;
        }
      }
      pitId = page.pitId;
      if (!page.docs.length) break;

      // Transform
      const rows = [];
      for (const d of page.docs) {
        try { rows.push(transformDoc(d, pipeline)); }
        catch (e) { dlq([d], { message: e.message, category: 'transform' }); dlqCount++; }
      }
      fetched += page.docs.length;

      // Dedup check
      let insertRows = rows;
      let dedupCheckFailed = false;
      const eventIds = rows.map(r => r.event_id).filter(Boolean);
      if (eventIds.length > 0) {
        try {
          const existing = await getExistingEventIds(cluster, pipeline.clickhouse_database, pipeline.clickhouse_table, eventIds);
          if (existing.length > 0) {
            const existingSet = new Set(existing);
            insertRows = rows.filter(r => !r.event_id || !existingSet.has(r.event_id));
            skipped += rows.length - insertRows.length;
          }
        } catch (e) {
          if (e.dedupUnsupported) {
            // No event_id column — dedup is impossible for this pipeline. There is no key
            // to dedup on, so inserting is unavoidable; surfaced loudly, warned once.
            if (!dedupFallbackLogged) { log('warn', e.message); dedupFallbackLogged = true; }
          } else if (e.dedupFallback) {
            // Dedup CHECK failed after retries (ClickHouse overloaded/unreachable).
            // Never insert without a dedup check — that silently reintroduces duplicates.
            // Route the whole batch to the DLQ instead, preserved for reprocessing once healthy.
            dedupCheckFailed = true;
            if (!dedupFallbackLogged) { log('warn', e.message); dedupFallbackLogged = true; }
          } else {
            throw e;
          }
        }
      }

      // Dedup check failed → DLQ the raw batch, insert nothing (no blind insert = no duplicates).
      if (dedupCheckFailed) {
        dlq(page.docs, { message: 'dedup check failed — batch routed to DLQ to avoid inserting without dedup', category: 'dedup_check_failed' });
        dlqCount += page.docs.length;
        insertRows = [];
      }

      if (insertRows.length > 0) {
        // Bulk serialize in this thread (true CPU parallelism — no event loop blocking)
        const ndjson     = insertRows.map(r => JSON.stringify(r)).join('\n');
        const insertStart = Date.now();
        await withRetry(
          () => chInsert(cluster, pipeline.clickhouse_database, pipeline.clickhouse_table, ndjson),
          insertRetryOpts
        );
        const now       = Date.now();
        inserted       += insertRows.length;
        const cycleMs   = Math.max(1, now - cycleStart);
        const insertMs  = Math.max(1, now - insertStart);
        const cycleRate = Math.round(insertRows.length / (cycleMs / 1000));
        const insertRate = Math.round(insertRows.length / (insertMs / 1000));
        log('info',
          `[worker-${workerId}] chunk ${chunk.id}: inserted ${insertRows.length} rows in ${(cycleMs / 1000).toFixed(1)}s ` +
          `(${cycleRate.toLocaleString()} rows/sec · insert ${insertRate.toLocaleString()}/s) (skipped ${skipped} dedup)`
        );
        const bytes = Buffer.byteLength(ndjson, 'utf8');
        parentPort.postMessage({ type: 'METRICS', inserted: insertRows.length, bytes });
      }

      cursorTs = page.nextCursor.ts;
      cursorId = page.nextCursor.id;
      // Send cursor back to main thread so it can resume from here on redistribution.
      parentPort.postMessage({ type: 'CURSOR_UPDATE', chunkId: chunk.id, cursorTs, cursorId });
      progress(chunk.id, fetched, inserted);
    }
  } finally {
    await closePit(conn, pitId).catch(() => {});
  }

  return { fetched, inserted, skipped, dlq: dlqCount };
}

// ── Message loop ──────────────────────────────────────────────────────────────

const { conn, cluster, pipeline, opts } = workerData;

parentPort.on('message', async (msg) => {
  if (msg.type !== 'PROCESS_CHUNK') return;
  const { chunk } = msg;
  const inPlaceRetries  = opts.inPlaceRetries ?? 5;
  const insertRetryOpts = opts.insertRetryOpts ?? { maxAttempts: 6, initialDelayMs: 1000, maxDelayMs: 30000 };

  for (let attempt = 0; attempt <= inPlaceRetries; attempt++) {
    try {
      const result = await ingestChunk(chunk, pipeline, conn, cluster, {
        workerId: workerData.workerId,
        batchSize: opts.batchSize,
        insertRetryOpts,
        tsField: opts.tsField,
      });
      parentPort.postMessage({ type: 'CHUNK_COMPLETE', chunkId: chunk.id, result });
      return;
    } catch (e) {
      if (e.message === 'RUN_CANCELLED') {
        parentPort.postMessage({ type: 'CHUNK_CANCELLED', chunkId: chunk.id });
        return;
      }
      log('warn', `[worker-${workerData.workerId}] chunk ${chunk.id} attempt ${attempt + 1}/${inPlaceRetries + 1} failed: ${String(e.message).slice(0, 160)}`);
      if (attempt < inPlaceRetries) await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  }
  parentPort.postMessage({ type: 'CHUNK_FAILED', chunkId: chunk.id });
});
