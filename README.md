# LogBridge

**LogBridge** is an open-source log shipping platform that streams logs from **OpenSearch / Wazuh Indexer** into **ClickHouse** for long-term, high-compression storage and analytics.

Built with Node.js 24, React 18, and SQLite — zero external dependencies for metadata storage.

---

## Branches

| Branch | Description |
|---|---|
| `main` | **V1** — Single-threaded async pipeline. Stable, production-proven. |
| `logbridge-v2` | **V2** — Multi-threaded pipeline using Node.js Worker Threads. Use this when running 5+ pipelines simultaneously. |
| `Logbridge-V3` | **V3** — Full UI rebuild (React 18 + Tailwind CSS v3 + Vite). Feature-complete parity with V2; UI-only upgrade with no backend regressions. |

---

## V3 — UI Rebuild

> **Branch:** `Logbridge-V3`

V3 is a ground-up frontend rebuild on top of V2's battle-tested backend. Every V2 feature is present — the only changes are visual and UX.

### What changed in V3

| Area | V2 | V3 |
|---|---|---|
| Styling | Plain CSS / inline styles | Tailwind CSS v3 design system |
| Build tool | Vite (unchanged) | Vite (unchanged) |
| Component structure | Monolithic page files | Modular pages + shared Shell |
| Settings | Inline in nav drawer | Dedicated `/settings` page with 4 tabs |
| User management | None | Full RBAC — create / edit / delete users, role assignment |
| Password management | Single-user change | Per-user profile + system-wide password policy |
| MFA | None | MFA toggle per user (TOTP, with backup codes) |
| Login activity | None | Audit log of last 200 login events (success / failure / IP) |
| System security | Hardcoded | Configurable lockout threshold, lockout duration, session timeout, password history depth |
| Dashboard metrics | 5-metric secondary band | 6-metric band — added **DLQ pending** (highlights in amber when > 0) |
| Jobs stats strip | 5 columns | 6 columns — added **Rows this week** |
| DLQ panel | View + dismiss | View + dismiss + **Retry all** (re-attempts inserts, spins while in progress) |

### New pages and files in V3

| File | Purpose |
|---|---|
| `frontend/src/pages/Settings.jsx` | 4-tab settings page: My Profile, User Management, System Security, Login Activity |
| `frontend/src/lib/permissions.js` | RBAC helper — `can.*` permission checks keyed on role weight |
| `backend/src/routes/users.js` | User CRUD API (`GET/POST/PUT/DELETE /api/users`) |
| `shipper/` | Rust/Cargo scaffolding for a future native shipper module |

### RBAC role hierarchy

| Role | Weight | Capabilities |
|---|---|---|
| `super_admin` | 4 | Everything — user management, system settings, all pipelines |
| `admin` | 3 | Pipeline management, connections, clusters; cannot manage users |
| `analyst` | 2 | Read pipelines, view jobs and log history |
| `viewer` | 1 | Read-only dashboard and pipeline list |

### V3 validated features (all 16 V2 features confirmed present)

All features from V2 are fully operational in V3 — verified by a page-by-page UI audit:

- ✅ PIT Pagination · Multi-Page Batching · Durable Checkpointing · Per-Index Partitioning
- ✅ Pull Modes (Continuous / From Date / Date Range / Scheduled)
- ✅ Dead Letter Queue (view + dismiss + **retry all**)
- ✅ Deduplication · Circuit Breaker Awareness · Retry with Backoff · Reconciliation
- ✅ Live Audit Feed · Field Mappings · Field Exclusions · Metrics
- ✅ Dry-Run Test Mode · JWT Auth + Credential Encryption

---

## V2 — Multi-Threaded Pipeline

> **Branch:** `logbridge-v2`

V2 replaces V1's single async event loop with true OS-level parallelism via **Node.js Worker Threads**. Each worker runs in its own thread on its own CPU core — JSON parsing, OpenSearch scrolling, ClickHouse inserts, and dedup checks all happen in parallel with zero contention.

### What changed in V2

| Component | V1 | V2 |
|---|---|---|
| Worker model | Async coroutines on 1 thread | True OS threads (Worker Threads) |
| Parallelism | Cooperative (event loop) | Preemptive (OS scheduler) |
| Cross-thread stop | `stopRequested()` flag | `SharedArrayBuffer` + `Atomics` |
| PIT rate-limiting | None | Atomic semaphore (`maxConcurrentPits=2`) |
| Cursor on redistribution | Lost (bug) | Sent back via `postMessage` |
| Dedup query | Single large IN-list (500 errors) | Chunked into 1000-ID sub-queries |
| Sidebar label | LogBridge | LogBridge · V2 · Multi-Thread |

### New files in V2

| File | Purpose |
|---|---|
| `backend/src/workerThread.js` | Worker Thread entry point — runs OpenSearch scroll + ClickHouse insert in its own OS thread |
| `backend/src/workerPool.js` | Thread pool — spawns N threads, routes chunks, manages SharedArrayBuffer semaphores |

### Why use V2 over V1?

V1 with 8 async workers is already network I/O-bound — adding more workers or vCPUs won't make a single pipeline faster. V2's advantage is **multi-pipeline load**:

- **V1:** 5 pipelines × 8 workers = 40 coroutines sharing 1 event loop. CPU-side work (JSON parsing, transform, dedup) competes on one core. One slow callback delays all others.
- **V2:** 5 pipelines × 8 workers = 40 true OS threads. Each thread runs independently on its own core. Pipelines don't interfere with each other.

**Use V2 when you need to run 3+ pipelines simultaneously at full throughput.**

### V2 PIT semaphore

Each Worker Thread opens its own OpenSearch PIT context. Without rate-limiting, 8 threads × 157 daily indices = hundreds of concurrent scroll contexts, hitting OpenSearch's `max_open_scroll_context` limit (default: 500) with HTTP 429 errors.

V2 solves this with a cross-thread atomic semaphore:

```
maxConcurrentPits = 2   (configurable via pipeline opts)
157 indices × 2 concurrent PITs = ~314 scroll contexts — safely under 500
```

The semaphore uses `SharedArrayBuffer` + `Atomics.compareExchange` — a lock-free spin loop that works across OS thread boundaries without serialization overhead.

### V2 hardware sizing

| Resource | Recommendation |
|---|---|
| vCPU | 4 vCPU supports 6–8 workers (workers are I/O-bound, not CPU-bound) |
| RAM | 8 workers × ~150 MB/worker = ~1.2 GB — safe on any 4 GB+ VM |
| Network | The real bottleneck — faster OpenSearch/ClickHouse network = faster ingestion |

### V2 validated results (local test)

- 0 duplicate rows after full pipeline run
- No `429 rejected_execution_exception` errors
- All workers staying `PROCESSING` throughout
- Dedup actively skipping already-inserted rows per batch
- Compression ratio: ~29×

---

## Table of Contents

- [How It Works — Feature Guide](#how-it-works--feature-guide)
  - [PIT Pagination](#1-pit-pagination--how-logbridge-reads-more-than-10000-logs-at-once)
  - [Multi-Page Batching](#2-multi-page-batching--graylog-style-accumulation)
  - [Durable Checkpointing](#3-durable-checkpointing--no-data-loss-on-crash)
  - [Per-Index Partitioning](#4-per-index-partitioning--one-cursor-per-daily-index)
  - [Pull Modes](#5-pull-modes--continuous-from-date-date-range-scheduled)
  - [Dead Letter Queue](#6-dead-letter-queue-dlq--nothing-is-silently-dropped)
  - [Deduplication](#7-deduplication--no-duplicate-rows-in-clickhouse)
  - [Circuit Breaker Awareness](#8-circuit-breaker-awareness--opensearch-heap-protection)
  - [Retry with Exponential Backoff](#9-retry-with-exponential-backoff)
  - [Reconciliation](#10-reconciliation--verify-nothing-was-missed)
  - [Live Audit Feed](#11-live-audit-feed--watch-every-batch-in-real-time)
  - [Field Mappings](#12-field-mappings--shape-your-data)
  - [Field Exclusions](#13-field-exclusions--strip-metadata-bloat-from-raw_data)
  - [Metrics](#14-metrics--real-time-throughput-tracking)
  - [Dry-Run Test Mode](#15-dry-run-test-mode)
  - [JWT Authentication & Credential Encryption](#16-jwt-authentication--credential-encryption)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Linux Installation (PM2)](#linux-installation-production--pm2)
- [ClickHouse — Create target tables](#clickhouse--create-target-tables)
- [Pipeline Configuration](#pipeline-configuration)
- [Performance](#performance)
- [PM2 Operations Reference](#pm2-operations-reference)
- [Project Structure](#project-structure)
- [Security Notes](#security-notes)
- [License](#license)

---

## How It Works — Feature Guide

This section explains every major LogBridge feature, so you understand not just *what* it does but *why* it works that way.

---

### 1. PIT Pagination — How LogBridge reads more than 10,000 logs at once

**The problem:** OpenSearch has a hard limit of 10,000 documents per search result (`max_result_window = 10000`). If your index has 500,000 logs, a normal query can only return the first 10,000 — then it stops.

**How LogBridge solves it:** It uses OpenSearch's **Point-In-Time (PIT)** feature combined with **`search_after`** pagination.

1. LogBridge opens a PIT "snapshot" on the index. This freezes a consistent view of the data so results don't shift while it is reading.
2. It fetches the first 10,000 documents, notes the sort key of the last document.
3. It then asks for the next 10,000 starting *after* that sort key — like turning a page in a book.
4. It keeps turning pages until it has collected all the documents it needs for this batch.
5. It closes the PIT snapshot to free OpenSearch memory.

This way, LogBridge can read **millions of documents** from a single index without hitting the 10,000 row wall.

---

### 2. Multi-Page Batching — Graylog-style accumulation

**The problem:** If LogBridge inserted into ClickHouse after every 10,000-document OpenSearch page, it would make thousands of tiny inserts. ClickHouse prefers fewer, larger inserts for better compression and performance.

**How LogBridge solves it:** It accumulates multiple OpenSearch pages in memory and makes **one large insert** into ClickHouse.

- Default batch size: **20,000 rows** (2 OpenSearch pages of 10,000 each)
- You can configure this to any number (e.g. 50,000 = 5 pages)
- All pages are assembled into a single NDJSON payload and sent to ClickHouse in one HTTP request

**Result:** Fewer round trips, better ClickHouse compression, higher throughput.

---

### 3. Durable Checkpointing — No data loss on crash

**The problem:** If LogBridge crashes mid-batch (power cut, OOM, network failure), how do you know which logs were already saved to ClickHouse and which weren't?

**How LogBridge solves it:** The checkpoint (the "where I was up to" marker) is only written to SQLite **after** ClickHouse confirms the insert succeeded.

The sequence is:
1. Fetch pages from OpenSearch → hold in memory
2. Send bulk insert to ClickHouse → wait for HTTP 200 OK
3. **Only then** write the new checkpoint to SQLite

If the process crashes between steps 1 and 3, the checkpoint still points to *before* those rows. On restart, LogBridge re-fetches them from OpenSearch. Some rows may be inserted twice, but deduplication (see below) handles that.

**The checkpoint stores:** the timestamp and sort key of the last document successfully committed, per-index.

---

### 4. Per-Index Partitioning — One cursor per daily index

When you configure a pipeline with specific daily indexes (e.g. `wazuh-archives-2024.03.01`, `wazuh-archives-2024.03.02`), LogBridge tracks progress **independently for each physical index**.

Each index gets its own row in the `pipeline_indexes` table with:
- Its own cursor (where it is up to)
- Its own checkpoint timestamp
- Its own row count and DLQ count
- Its own error state

**Why this matters:** If the March 1st index errors out, March 2nd and 3rd continue running normally. You can see per-index status and reset individual index cursors from the UI without affecting others.

If you use a wildcard pattern (`wazuh-archives-*`) instead of specific indexes, all matching indexes share a single pipeline-level cursor.

---

### 5. Pull Modes — Continuous, From Date, Date Range, Scheduled

LogBridge supports four pull modes. Each defines the **time window** the pipeline reads from — and that same window is what the [Reconciliation](#10-reconciliation--verify-nothing-was-missed) and **Check Timestamps** features use to report totals.

**Continuous** (`pull_mode: continuous`):
- Tracks a cursor (last timestamp processed) and catches up in real time
- After each batch, waits `poll_interval_secs` (default: 30s), then checks for new logs
- Default mode for ongoing production pipelines · window = whole index

**From Date** (`pull_mode: from_date`):
- You specify `pull_from_date`; LogBridge ships everything from that date up to now
- Window = `[from → now]` · use for "catch me up from date X"

**Date Range** (`pull_mode: date_range`):
- You specify `pull_from_date` and `pull_to_date`
- Window = `[from → to]`; once it reaches the end date it stops automatically
- Use this for **historical backfill** — shipping old archived data in one go

**Scheduled (Cron)** (`pull_mode: scheduled`):
- Runs on a cron expression (`schedule_cron`), each trigger pulling a rolling
  `schedule_lookback_hours` window ending at trigger time
- A **cursor (`cursor_timestamp`)** records the end of the last successful run, so the next
  run starts exactly where the last one ended — **no gaps even if the cron fires late**
- The cursor is only advanced after a run completes successfully (see the data-safety note below)

**Parallel Workers** (`parallel_slices`, backfill/scheduled modes): the window is processed by a
**shared work-queue of small chunks** consumed by a pool of N worker coroutines. This is what makes
one trigger complete an entire window with dynamic load balancing:

- The window is split into **many small time chunks** (≈ `parallel_slices × 5`, floored at 1-minute
  chunks) — more chunks than workers, so fast workers keep pulling more while a dense region is still
  draining. No worker permanently owns a slice; claiming a chunk is a synchronous queue operation
  (single process, so no locks and no double-processing).
- **Index-aware routing:** each chunk opens its PIT only on the physical indices whose *data* time
  span overlaps that chunk (learned from a one-shot min/max-per-`_index` aggregation — no index-name
  parsing, so it works for daily-rotated, non-daily, single, or multi-index layouts alike). On a
  157-daily-index pattern this cuts the per-request fan-out from 157 indices to ≈7, keeping open
  search contexts far below the server limit.
- **Fetch is PIT + `search_after`** (not scroll), resuming each chunk from a durable per-chunk cursor.
- **Retry & redistribution within the same trigger:** a failing chunk is retried in place up to
  `retry_count` times by the same worker; if still failing it is requeued for another worker (up to a
  bounded number of redistributions). A worker failing does **not** fail the work — the chunk does.
- **Centralized finalization (all-or-nothing cursor):** after all workers drain the queue, a single
  finalizer verifies **every** chunk is `COMPLETE`. Only then is the cursor advanced to the window
  end. If any chunk is permanently `FAILED` (or the run was paused), the cursor is left unchanged and
  the run reports `WINDOW INCOMPLETE`, so the next trigger re-covers the window.

> Each worker holds one PIT context per shard of its chunk's routed indices, so keep an eye on the
> server's `search.max_open_pit_context` limit for very wide windows with many workers; index-aware
> routing keeps this small in normal operation. PIT contexts are closed as each chunk finishes;
> a hard process kill can leave contexts open until their 5-minute keep-alive expires.

**Max run time** (`max_run_minutes`, optional; 0 = unlimited): a per-trigger time budget so a run
can't overrun indefinitely. When the deadline is reached the run stops claiming new chunks, lets any
in-flight ClickHouse insert finish, closes its PITs, and reports `WINDOW INCOMPLETE` **without
advancing the cursor** — so the next trigger safely re-covers the window and dedup-skips whatever
already landed. It reuses the same cancellation path as a pause, so recovery is identical. A pipeline
also can't run twice concurrently: the scheduler holds one execution token per pipeline for the whole
run (including its post-failure backoff), so a new trigger is skipped until the previous run fully
unwinds.

**Data-safety guarantee:** a partial fetch (`timed_out`, shard failures, or fewer docs than OpenSearch
reported) **aborts loudly instead of being treated as "done,"** and the cursor is never advanced past
an incomplete window. Combined with `event_id` [deduplication](#7-deduplication--no-duplicate-rows-in-clickhouse)
and a `ReplacingMergeTree` target, this gives no-gap **and** no-duplicate ingestion even across
retries and redistribution.

You can switch modes at any time by editing the pipeline. The cursor is preserved unless you explicitly reset it.

---

### 6. Dead Letter Queue (DLQ) — Nothing is silently dropped

**The problem:** What happens if a single malformed document can't be transformed or inserted? Without a DLQ, you would either crash the whole batch or silently skip the bad document.

**How LogBridge solves it:** Any document that fails processing is written to the **Dead Letter Queue** — a `pipeline_dlq` table in SQLite. It stores:

- The original document (full JSON)
- The source index and document ID
- The error message and error category
- The timestamp of first and last failure
- A retry count

**What you can do with DLQ items:**
- **View them** in the pipeline detail page — see exactly which documents failed and why
- **Retry them** — LogBridge re-attempts the transform and insert, marks them resolved if they succeed
- **Delete them** — discard items you don't need

The pipeline continues processing normally even when items are in the DLQ. Nothing is silently lost.

---

### 7. Deduplication — No duplicate rows in ClickHouse

**The problem:** Because LogBridge re-fetches logs after a crash (to guarantee no data loss), it may sometimes insert the same log twice.

**How LogBridge solves it:** Before inserting, it generates a hash of a configurable field (default: `raw_data`) using MD5 or SHA-256. It stores this hash as the `event_id` column in ClickHouse. If a document with the same `event_id` already exists, it is skipped.

You can configure:
- **Dedup field** — which field to hash (default: `raw_data`, the full raw log JSON)
- **Dedup algorithm** — `md5` (faster) or `sha256` (stronger)
- **Disable dedup** — turn it off entirely for maximum throughput if your pipeline never crashes

The number of rows skipped by deduplication is tracked in the pipeline stats (`rows_skipped_dedup`).

---

### 8. Circuit Breaker Awareness — OpenSearch heap protection

**What is a circuit breaker?** OpenSearch has a built-in safety mechanism: if a query is about to exceed the JVM heap limit, OpenSearch rejects it with a `circuit_breaking_exception` error instead of crashing the whole node.

**The problem:** LogBridge used to classify HTTP 500 errors as "retryable" and would retry the failed request automatically. But a circuit breaker error is **permanent** — the node is already out of memory, so retrying the same large query just makes it worse. It triggers the circuit breaker again, and again, until the node is overwhelmed.

**How LogBridge handles it now:**
1. It detects `circuit_breaking_exception` and `data too large` in the error response body
2. It immediately marks the error as **non-retryable** — no retry storm
3. It pauses the pipeline and writes a clear human-readable error message: *"OpenSearch heap pressure: the OS node ran out of JVM heap during search. Reduce batch_size, or increase the OpenSearch node's heap."*
4. You fix the root cause (reduce batch size or increase `-Xmx` in OpenSearch's `jvm.options`), then restart the pipeline

**Recommended OpenSearch heap:** At least **4 GB** (`-Xms4g -Xmx4g`) for index patterns spanning many daily indices.

---

### 9. Retry with Exponential Backoff

For errors that *are* recoverable (network blips, temporary 429 rate limits, ClickHouse restarts), LogBridge retries automatically with increasing delays between attempts.

- Default retry count: **3 attempts**
- Strategy: exponential backoff with jitter (waits longer each attempt to avoid thundering-herd)
- Retryable: 429 Too Many Requests, 502/503/504 gateway errors, network timeouts
- Non-retryable: circuit breaker exceptions, 400 Bad Request (schema mismatch), auth errors

If all retries are exhausted, the pipeline pauses itself (so the checkpoint is preserved) and writes the error to the audit log.

You can configure the retry count per pipeline (0 = no retries, fail immediately).

---

### 10. Reconciliation — Verify nothing was missed

Reconciliation is a fairness check between the **source** (OpenSearch / Wazuh indexer) and the
**destination** (ClickHouse): *did everything that should have been copied actually make it across?*

It is **mode-aware** — it compares only the window the pipeline was configured to pull, and only the
selected indexes, so the comparison is always apples-to-apples:

| Pull mode | Window compared |
|---|---|
| Date Range | `[from → to]` |
| From Date | `[from → now]` |
| Continuous / Scheduled | whole index (no fixed window) |

If specific physical indexes are selected on the pipeline, the source count is scoped to those; otherwise the index pattern is used.

**What it reports** (auto-refreshes every 30s on the pipeline card, or click ↻ to run now):

- **Source (OpenSearch)** — exact document count in the window (uses `track_total_hits`, so it is not capped at 10,000)
- **Ingested (ClickHouse)** — rows present in ClickHouse for the same window
- **Remaining** — `Source − Ingested` = docs still to ingest, with a **% ingested** progress figure
- **Source span / Ingested span** — the oldest → newest timestamp actually present on each side, so you can see *where* a gap is (e.g. if the ingested tail stops earlier than the source)
- **Verdict** — `COMPLETE` when the counts match, `PARTIAL` when ClickHouse is behind

Each side is fetched with a single query that returns count + oldest + newest together (an OpenSearch
`size:0` search with min/max aggregations; a ClickHouse `count()/min()/max()`).

**What PARTIAL means:** more documents in the source than in ClickHouse = logs still to ship (pipeline
catching up, or a run aborted). Use reconciliation after a historical backfill or crash recovery to
confirm completeness, and to watch backfill progress in real time.

---

### 11. Live Audit Feed — Watch every batch in real-time

The **Jobs** page shows a scrolling live feed of pipeline activity. Every event is logged in real time as it happens:

**What you see per batch entry:**
- Timestamp (in your configured timezone)
- Pipeline name
- Category tag: `[batch_insert]`, `[checkpoint]`, `[error]`, `[dlq]`, etc.
- Log level: `info`, `warn`, `error`
- Full message: source index name, rows fetched, rows inserted, from/to timestamps, rows skipped

**Controls:**
- **Copy All** — copies every visible log line to your clipboard as plain text (useful for pasting into a ticket or support thread)
- **Reset** — hides all current log lines from the display. New logs from this moment forward continue appearing. The underlying data in SQLite is not deleted.
- **Auto-scroll** — the feed scrolls to new entries as they arrive. You can scroll up to read history without interrupting the live feed.
- **Filter by pipeline** — select a specific pipeline to see only its logs

The feed polls the backend every 3 seconds. Log entries are stored in the `pipeline_logs` SQLite table and retained indefinitely.

---

### 12. Field Mappings — Shape your data

When a log document arrives from OpenSearch, it may have a different field structure than your ClickHouse table. Field mappings let you rename, flatten, and transform fields before insertion.

**Example:** Your Wazuh archive has `data.win.system.eventID` but your ClickHouse table expects a column called `event_id`. You add a field mapping:
- Source field: `data.win.system.eventID`
- Destination column: `event_id`
- Transform: `string` (convert to string if numeric)

Fields not covered by a mapping are either ignored or placed in a `raw_data` catch-all column (depending on your ClickHouse table schema).

You also configure:
- **Customer field** — which field (or fixed value) to write to the `customer` column
- **Product field** — which field (or fixed value) to write to the `product` column

These support both field-extraction (`source: field`) and static values (`source: static`).

---

### 13. Field Exclusions — Strip metadata bloat from `raw_data`

When a log document is stored as `raw_data` (the full OpenSearch document serialised as JSON), it includes not just the useful log fields but also indexer metadata that bloat storage without adding analytical value.

**Common offenders in Graylog / Wazuh pipelines:**

| Field | What it is | Typical size |
|---|---|---|
| `gl2_*` fields | Graylog internal routing metadata | ~400 bytes each |
| `streams` | Graylog stream IDs the message belongs to | ~100 bytes |
| `message` | Raw syslog string — duplicated inside the structured JSON | ~200–800 bytes |
| `_id` | OpenSearch document ID (already tracked separately) | ~35 bytes |
| `_index` | Source index name (tracked in pipeline metadata) | ~40 bytes |

**Measured impact:** A Graylog-enriched document averages **~3,677 bytes/row** without exclusions. Excluding `gl2_*`, `streams`, `_id`, `_index`, and `message` brings it to **~800 bytes/row** — a **78% reduction** that directly translates to lower ClickHouse storage.

**How to configure:**

1. Open a pipeline → **Step 4: Tagging & Batching** → scroll to **Field Exclusions**
2. Click **"Fetch fields from sample doc"** — LogBridge queries 10 recent documents from OpenSearch and returns the union of all fields discovered, including:
   - Top-level fields (`_id`, `_index`, `agent`, `decoder`, …)
   - One level of nested sub-fields (`agent.name`, `predecoder.hostname`, …)
   - Sub-keys of any JSON-string fields (e.g. `message.src_ip` for Graylog-wrapped FortiGate logs)
3. Tick the fields to exclude. Use **"Select all gl2_*"** to instantly mark all Graylog metadata fields.
4. Selected fields appear as removable tags above the checklist.
5. Save the pipeline.

**How exclusions are applied at ingest time:**

When the runner fetches a batch from OpenSearch, each document's `raw_data` value is built by:

```
stripped_doc = doc - excluded_fields
raw_data = JSON.stringify(stripped_doc)
```

Exclusions support both **top-level keys** (`_id`) and **dot-path sub-fields** (`agent.name`). Excluding a dot-path removes only that leaf — the parent object and sibling fields are preserved. The original document is not mutated — dedup hashing and DLQ logging still see the full unstripped document.

> **Note:** Field exclusions only apply to mappings with **Source Type = Full Doc JSON**. Individually mapped fields (Source Type = Field) are unaffected.

---

### 14. Metrics — Real-time throughput tracking

LogBridge tracks throughput over a **60-second sliding window**:

- **EPS** — Events per second (rows inserted per second, rolling average)
- **MB/s** — Data throughput in megabytes per second

These are visible on the Dashboard and pipeline cards. The metrics reset when the backend restarts.

Additional counters tracked per pipeline:
- `rows_inserted_total` — all-time rows inserted
- `rows_inserted_today` — rows inserted since midnight
- `rows_inserted_week` — rows inserted this calendar week
- `rows_skipped_dedup` — rows not inserted because they were duplicates
- `rows_dlq` — rows sent to the Dead Letter Queue
- `bytes_processed` — total bytes fetched from OpenSearch
- `event_lag_secs` — how far behind real-time the cursor is (now − cursor timestamp at last commit)
- `last_run_duration_ms` — how long the last batch took end-to-end

---

### 15. Dry-Run Test Mode

Before you start a pipeline for real, you can run a **dry run**:

1. Go to a pipeline → click "Test Run"
2. LogBridge fetches one page from OpenSearch and runs the transform
3. It returns sample rows showing *exactly* what would be inserted into ClickHouse
4. **Nothing is written** — no ClickHouse insert, no checkpoint update

Use this to verify your field mappings are correct and your ClickHouse schema matches the output before committing to a full run.

---

### 16. JWT Authentication & Credential Encryption

**Authentication:**
- LogBridge uses **JWT (JSON Web Tokens)** for API access
- You log in once with username + password → receive a token
- The token is sent with every API request
- If the token expires or is invalid, you are redirected to the login page automatically
- All API routes except `POST /api/auth/login` require a valid token

**Credential encryption:**
- OpenSearch and ClickHouse passwords are **never stored in plaintext**
- They are encrypted with **AES-256-GCM** before being written to SQLite
- The encryption key is stored separately in `backend/logbridge.key` or the `LOGBRIDGE_ENCRYPTION_KEY` environment variable
- Passwords are **never returned** in API GET responses — only connection names and URLs are exposed

**Default credentials:**
- Username: `admin`
- Password: `admin123`
- Change the password immediately after first login via Settings → Change Password

---

## Architecture

### V1 (main)

```
┌─────────────────────────────────────────────────────────────┐
│                        LogBridge V1                         │
│                                                             │
│  React 18 UI (Vite)          Node.js 24 Backend (Express)  │
│  ┌──────────────────┐        ┌──────────────────────────┐  │
│  │ Dashboard        │◄──────►│ REST API (:4000)         │  │
│  │ Pipelines        │  JWT   │ Scheduler (per-pipeline) │  │
│  │ Connections      │        │ Runner — async workers   │  │
│  │ Clusters         │        │ SQLite (WAL mode)        │  │
│  │ Jobs / Live Feed │        └──────────────────────────┘  │
│  └──────────────────┘                  │                    │
└─────────────────────────────────────────│───────────────────┘
                                          │
              ┌───────────────────────────┼──────────────────┐
              ▼                           ▼
   OpenSearch / Wazuh Indexer       ClickHouse
   (source — PIT + search_after)    (destination — HTTP)
```

### V2 (logbridge-v2)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         LogBridge V2                                 │
│                                                                      │
│  React 18 UI            Node.js 24 Main Thread (Express + SQLite)   │
│  ┌─────────────┐        ┌────────────────────────────────────────┐  │
│  │ Dashboard   │◄──────►│ REST API (:4000)  Scheduler            │  │
│  │ Pipelines   │  JWT   │ Runner.js         WorkerPool           │  │
│  │ Jobs (feed) │        │ SQLite WAL        SharedArrayBuffer     │  │
│  └─────────────┘        └──────────────┬───────────────────────┘  │
└────────────────────────────────────────│──────────────────────────┘
                                         │ postMessage (chunks)
              ┌──────────────────────────┼──────────────────────────┐
              │          Worker Threads (one per worker slot)        │
              │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ...     │
              │  │ Thread 0 │  │ Thread 1 │  │ Thread 2 │          │
              │  │ OS core  │  │ OS core  │  │ OS core  │          │
              │  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
              └───────│─────────────│──────────────│────────────────┘
                      │             │              │
              ┌───────▼─────────────▼──────────────▼───────┐
              │   OpenSearch / Wazuh Indexer (PIT scroll)   │
              └─────────────────────────────────────────────┘
                      │             │              │
              ┌───────▼─────────────▼──────────────▼───────┐
              │   ClickHouse (bulk INSERT JSONEachRow)       │
              └─────────────────────────────────────────────┘
```

### Data flow per batch (V2)

```
Main thread:
1. Split window into N time chunks
2. Submit chunks to WorkerPool queue

Each Worker Thread (in parallel):
3. Acquire PIT semaphore slot (SharedArrayBuffer Atomics)
4. Open PIT snapshot on routed indices only
5. Release semaphore slot
6. Fetch pages via search_after pagination
7. After each page: send CURSOR_UPDATE to main thread (safe redistribution)
8. Transform docs using pipeline field mappings
9. Dedup-check event IDs against ClickHouse (chunked 1000-ID queries)
10. Bulk INSERT into ClickHouse via INSERT ... FORMAT JSONEachRow
11. Send CHUNK_COMPLETE to main thread with inserted count
12. Close PIT snapshot

Main thread (finalization):
13. All chunks COMPLETE → advance cursor checkpoint in SQLite
14. Any chunk FAILED → leave cursor unchanged → next trigger re-covers window
```

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| Node.js | **24+** | Uses built-in `node:sqlite` — no external SQLite package |
| npm | 10+ | Bundled with Node 24 |
| OpenSearch / Wazuh Indexer | 2.x+ | Source for logs |
| ClickHouse | 23.x+ | Destination for logs |
| PM2 | latest | Process manager for production |

---

## Linux Installation (Production — PM2)

### 1. Install Node.js 24

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

### 2. Install PM2 globally

```bash
sudo npm install -g pm2
```

### 3. Clone the repository

```bash
git clone https://github.com/QuantumDef1337/LogBridge.git
cd LogBridge
```

### 4. Install backend dependencies

```bash
cd backend
npm install --omit=dev
cd ..
```

### 5. Build the frontend

```bash
cd frontend
npm install
npm run build
cd ..
```

### 6. Configure environment variables

```bash
cp backend/.env.example backend/.env
nano backend/.env
```

```env
PORT=4000
JWT_SECRET=your-long-random-secret-here
LOGBRIDGE_ENCRYPTION_KEY=your-32-byte-hex-key-here
```

Generate a secure encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Important:** Never commit `.env` or `logbridge.key` to version control. The encryption key encrypts all stored OpenSearch and ClickHouse credentials with AES-256-GCM.

### 7. Serve the frontend with Nginx (recommended)

```bash
sudo apt-get install -y nginx
```

Create `/etc/nginx/sites-available/logbridge`:

```nginx
server {
    listen 80;
    server_name your-server-ip-or-domain;

    root /opt/logbridge/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/logbridge /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 8. Create PM2 ecosystem config

```bash
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'logbridge-backend',
      script: 'src/index.js',
      cwd: './backend',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      env_file: './backend/.env',
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
EOF

mkdir -p logs
```

### 9. Start with PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Check it is running:

```bash
pm2 status
pm2 logs logbridge-backend --lines 50
```

### 10. Verify

Open `http://your-server-ip` in your browser.

Default login: **admin / admin123**

> Change the default password immediately via Settings → Change Password.

---

## ClickHouse — Create target tables

```sql
CREATE DATABASE IF NOT EXISTS Logs;

CREATE TABLE IF NOT EXISTS Logs.wazuh_archives_raw
(
    timestamp       DateTime64(3, 'UTC'),
    ingestion_time  DateTime64(3, 'UTC') DEFAULT now64(3),
    customer        LowCardinality(String) DEFAULT '',
    product         LowCardinality(String) DEFAULT '',
    source          String                 DEFAULT '',
    event_id        String                 DEFAULT '',
    raw_data        String CODEC(ZSTD(6))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, event_id)
SETTINGS index_granularity = 8192;
```

A full schema reference is in [`sql/wazuh_alerts_raw.sql`](sql/wazuh_alerts_raw.sql).

---

## Pipeline Configuration

1. **Connections** — add your OpenSearch / Wazuh Indexer URL, username, and password
2. **Clusters** — add your ClickHouse URL, username, password, and default database
3. **Pipelines** — create a pipeline:
   - Select source connection + index pattern (e.g. `wazuh-archives-*`) or specific daily indexes
   - Select destination cluster + database + table
   - Configure field mappings (source field → ClickHouse column)
   - Set pull mode: `continuous` (live shipping) or `date_range` (historical backfill)
   - Set batch size (default 20,000 — uses 2 × 10K OpenSearch pages per insert)
   - Set poll interval (how often to check for new logs, default 30 seconds)
   - Enable/disable deduplication and choose the hash algorithm
   - Configure **Field Exclusions** — fetch fields from a sample doc and tick which ones to strip from `raw_data` before insert (reduces storage bloat from indexer metadata)
4. **Test Run** — verify your field mappings with a dry run before going live
5. **Start** the pipeline — monitor progress in **Jobs → Live Audit Feed**

---

## Performance

| Metric | Value |
|---|---|
| Batch size | 10,000 rows per worker per batch (configurable) |
| Sustained throughput | ~500–7,000 rows/sec per worker (depends on index density and network) |
| ClickHouse compression | ~29–43× (ZSTD — varies by log type) |
| ClickHouse insert timeout | 120 seconds |
| Poll interval | 30 seconds (configurable per pipeline) |
| Max concurrent PITs (V2) | 2 (configurable via `maxConcurrentPits`) |

**V2 recommended worker count by VM size:**

| VM vCPU | Recommended workers | Notes |
|---|---|---|
| 2 vCPU | 4 workers | Main thread shares one core |
| 4 vCPU | 6–8 workers | Workers are I/O-bound; over-provisioning is safe |
| 8 vCPU | 10–12 workers | Increase `maxConcurrentPits` to 4 if >500 indices |

**OpenSearch heap:** Each PIT scan loads shard data into OS JVM heap. For patterns spanning many daily indices (e.g. `wazuh-archives-*` across 157 daily indices), the OS node needs at least **4 GB heap** (`-Xms4g -Xmx4g` in `jvm.options`). Lower heap causes `circuit_breaking_exception` which LogBridge detects and handles without a retry storm.

**Batch size tuning:**
- Larger batches = fewer ClickHouse inserts = better compression, but more OS heap used per batch
- If you see `circuit_breaking_exception`, reduce batch size (try 5,000) before increasing heap
- Default of 10,000 works well for most Wazuh deployments with ≥4 GB OS heap

**PIT semaphore tuning (V2):**
- Default `maxConcurrentPits=2` is safe for any OpenSearch cluster with default settings (500 context limit)
- Formula: `maxConcurrentPits × number_of_indices < max_open_scroll_context`
- Example: 4 PITs × 157 indices = 628 contexts → exceeds default 500 → keep at 2
- Raise the limit instead: `PUT /_cluster/settings {"persistent":{"search.max_open_scroll_context":5000}}`

---

## PM2 Operations Reference

```bash
pm2 status                          # show all processes
pm2 logs logbridge-backend          # tail live logs
pm2 restart logbridge-backend       # restart after config change
pm2 stop logbridge-backend          # stop
pm2 delete logbridge-backend        # remove from PM2
pm2 monit                           # live CPU/memory dashboard
```

---

## Project Structure

```
LogBridge/
├── backend/
│   ├── src/
│   │   ├── index.js           # Express server + graceful shutdown
│   │   ├── db.js              # SQLite schema + WAL mode + migrations
│   │   ├── scheduler.js       # Per-pipeline execution loop
│   │   ├── runner.js          # Chunk splitter + WorkerPool orchestration (V2)
│   │   ├── workerPool.js      # [V2] Thread pool — spawns/reuses Worker Threads
│   │   ├── workerThread.js    # [V2] Worker Thread — OpenSearch scroll + CH insert
│   │   ├── retry.js           # Exponential backoff + error classification
│   │   ├── auth.js            # JWT sign/verify + requireAuth middleware
│   │   ├── crypto.js          # AES-256-GCM credential encryption
│   │   ├── audit.js           # Pipeline audit log helpers
│   │   ├── routes/
│   │   │   ├── auth.js        # POST /api/auth/login, change-password
│   │   │   ├── pipelines.js   # Pipeline CRUD + run/pause/reconcile/DLQ
│   │   │   ├── connections.js
│   │   │   ├── clusters.js
│   │   │   ├── jobs.js        # Pipeline logs + status
│   │   │   ├── users.js       # [V3] User CRUD + RBAC role management
│   │   │   └── health.js      # GET /api/health, /api/metrics
│   │   └── services/
│   │       ├── opensearch.js  # PIT open/fetch/close, search_after pagination
│   │       ├── clickhouse.js  # INSERT, query, dedup check (1000-ID chunked), row count
│   │       └── metrics.js     # 60s sliding window EPS/MB tracker
│   ├── tests/
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx            # Routes + PrivateRoute guard
│   │   ├── api.js             # Fetch wrapper + JWT headers + 401 redirect
│   │   ├── pages/
│   │   │   ├── Login.jsx
│   │   │   ├── Dashboard.jsx
│   │   │   ├── Pipelines.jsx
│   │   │   ├── PipelineEditor.jsx
│   │   │   ├── Connections.jsx
│   │   │   ├── Clusters.jsx
│   │   │   ├── Jobs.jsx       # Live Audit Feed + DLQ retry + Copy All + Reset
│   │   │   └── Settings.jsx   # [V3] My Profile / User Mgmt / System / Login Activity
│   │   ├── lib/
│   │   │   └── permissions.js # [V3] RBAC can.* helpers keyed on role weight
│   │   └── components/
│   │       └── Shell.jsx      # App shell + nav + logout
│   └── package.json
├── sql/
│   └── wazuh_alerts_raw.sql   # ClickHouse table DDL
├── ecosystem.config.js        # PM2 config
├── backend/.env.example       # Environment variable template
└── README.md
```

---

## Security Notes

- All OpenSearch and ClickHouse credentials are encrypted at rest with **AES-256-GCM** using a key stored in `backend/logbridge.key` or the `LOGBRIDGE_ENCRYPTION_KEY` environment variable
- Passwords are **never returned** in API GET responses — only names and URLs are exposed
- JWT tokens expire (configured in `auth.js`)
- All API routes require a valid JWT except `POST /api/auth/login`
- The `.gitignore` excludes `*.db`, `*.key`, `.env`, and `logbridge.key` — these must never be committed

---

## License

MIT
