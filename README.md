# LogBridge

**LogBridge** is an open-source log shipping platform that streams logs from **OpenSearch / Wazuh Indexer** into **ClickHouse** for long-term, high-compression storage and analytics.

Built with Node.js 24, React 18, and SQLite — zero external dependencies for metadata storage.

---

## Table of Contents

- [How It Works — Feature Guide](#how-it-works--feature-guide)
  - [PIT Pagination](#1-pit-pagination--how-logbridge-reads-more-than-10000-logs-at-once)
  - [Multi-Page Batching](#2-multi-page-batching--graylog-style-accumulation)
  - [Durable Checkpointing](#3-durable-checkpointing--no-data-loss-on-crash)
  - [Per-Index Partitioning](#4-per-index-partitioning--one-cursor-per-daily-index)
  - [Pull Modes](#5-pull-modes--continuous-vs-date-range)
  - [Dead Letter Queue](#6-dead-letter-queue-dlq--nothing-is-silently-dropped)
  - [Deduplication](#7-deduplication--no-duplicate-rows-in-clickhouse)
  - [Circuit Breaker Awareness](#8-circuit-breaker-awareness--opensearch-heap-protection)
  - [Retry with Exponential Backoff](#9-retry-with-exponential-backoff)
  - [Reconciliation](#10-reconciliation--verify-nothing-was-missed)
  - [Live Audit Feed](#11-live-audit-feed--watch-every-batch-in-real-time)
  - [Field Mappings](#12-field-mappings--shape-your-data)
  - [Metrics](#13-metrics--real-time-throughput-tracking)
  - [Dry-Run Test Mode](#14-dry-run-test-mode)
  - [JWT Authentication & Credential Encryption](#15-jwt-authentication--credential-encryption)
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

### 5. Pull Modes — Continuous vs date range

**Continuous mode** (`pull_mode: continuous`):
- LogBridge tracks a cursor (last timestamp processed)
- After each batch, it waits `poll_interval_secs` (default: 30 seconds), then checks for new logs
- It catches up in real time — as Wazuh writes new logs, LogBridge ships them within seconds
- This is the default mode for ongoing production pipelines

**Date range mode** (`pull_mode: date_range`):
- You specify a `pull_from_date` and `pull_to_date`
- LogBridge fetches only logs within that window
- Once it reaches the end date, it stops automatically
- Use this for **historical backfill** — shipping old archived data into ClickHouse in one go

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

Reconciliation compares the number of documents in OpenSearch against the number of rows in ClickHouse for the same index and time range.

**How to use it:**
1. Go to a pipeline's detail page
2. Click "Reconcile"
3. Optionally specify a date range to scope the comparison
4. LogBridge queries OpenSearch for the count and ClickHouse for the count
5. It reports `MATCH`, `MISMATCH`, or `INCONCLUSIVE` per index

**What MISMATCH means:** More documents in OpenSearch than ClickHouse = some logs may not have been shipped yet (pipeline is still catching up) or were lost. Fewer in OpenSearch = documents may have been deleted from the source (normal for index rotation).

Use reconciliation after a historical backfill or after a crash recovery to confirm completeness.

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

### 13. Metrics — Real-time throughput tracking

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

### 14. Dry-Run Test Mode

Before you start a pipeline for real, you can run a **dry run**:

1. Go to a pipeline → click "Test Run"
2. LogBridge fetches one page from OpenSearch and runs the transform
3. It returns sample rows showing *exactly* what would be inserted into ClickHouse
4. **Nothing is written** — no ClickHouse insert, no checkpoint update

Use this to verify your field mappings are correct and your ClickHouse schema matches the output before committing to a full run.

---

### 15. JWT Authentication & Credential Encryption

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

```
┌─────────────────────────────────────────────────────────────┐
│                        LogBridge                            │
│                                                             │
│  React 18 UI (Vite)          Node.js 24 Backend (Express)  │
│  ┌──────────────────┐        ┌──────────────────────────┐  │
│  │ Dashboard        │◄──────►│ REST API (:4000)         │  │
│  │ Pipelines        │  JWT   │ Scheduler (per-pipeline) │  │
│  │ Connections      │        │ Runner (PIT + batching)  │  │
│  │ Clusters         │        │ SQLite (WAL mode)        │  │
│  │ Jobs / Live Feed │        └──────────────────────────┘  │
│  └──────────────────┘                  │                    │
└─────────────────────────────────────────│───────────────────┘
                                          │
              ┌───────────────────────────┼──────────────────┐
              │                           │                   │
              ▼                           ▼                   │
   OpenSearch / Wazuh Indexer       ClickHouse               │
   (source — PIT + search_after)    (destination — HTTP)      │
```

### Data flow per batch

```
1. Open a PIT snapshot on the source index pattern
2. Fetch pages of up to 10,000 docs each (search_after pagination)
3. Accumulate pages until batch_size is reached
4. Transform docs using field mappings defined in the pipeline
5. Dedup-check event IDs against ClickHouse (optional)
6. Single bulk insert into ClickHouse via INSERT ... FORMAT JSONEachRow
7. Commit checkpoint to SQLite ONLY after ClickHouse ACK
8. Close the PIT snapshot
9. Wait poll_interval_secs, then repeat
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
4. **Test Run** — verify your field mappings with a dry run before going live
5. **Start** the pipeline — monitor progress in **Jobs → Live Audit Feed**

---

## Performance

| Metric | Value |
|---|---|
| Batch size | 20,000 rows (2 × 10K OS pages, configurable) |
| Sustained throughput | ~600–1,200 rows/sec (depends on OS index density) |
| ClickHouse compression | ~43× (ZSTD — 24 GB uncompressed → 551 MB on-disk) |
| ClickHouse insert timeout | 120 seconds |
| Poll interval | 30 seconds (configurable per pipeline) |

**OpenSearch heap:** Each PIT scan loads shard data into OS JVM heap. For patterns spanning many daily indices (e.g. `wazuh-archives-*` across 30 days), the OS node needs at least **4 GB heap** (`-Xms4g -Xmx4g` in `jvm.options`). Lower heap causes `circuit_breaking_exception` which LogBridge detects and handles without a retry storm.

**Batch size tuning:**
- Larger batches = fewer ClickHouse inserts = better compression, but more OS heap used per batch
- If you see `circuit_breaking_exception`, reduce batch size (try 5,000) before increasing heap
- Default of 20,000 works well for most Wazuh deployments with ≥4 GB OS heap

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
│   │   ├── index.js          # Express server + graceful shutdown
│   │   ├── db.js             # SQLite schema + WAL mode + migrations
│   │   ├── scheduler.js      # Per-pipeline execution loop
│   │   ├── runner.js         # PIT fetch + transform + CH insert
│   │   ├── retry.js          # Exponential backoff + error classification
│   │   ├── auth.js           # JWT sign/verify + requireAuth middleware
│   │   ├── crypto.js         # AES-256-GCM credential encryption
│   │   ├── audit.js          # Pipeline audit log helpers
│   │   ├── routes/
│   │   │   ├── auth.js       # POST /api/auth/login, change-password
│   │   │   ├── pipelines.js  # Pipeline CRUD + run/pause/reconcile/DLQ
│   │   │   ├── connections.js
│   │   │   ├── clusters.js
│   │   │   ├── jobs.js       # Pipeline logs + status
│   │   │   └── health.js     # GET /api/health, /api/metrics
│   │   └── services/
│   │       ├── opensearch.js # PIT open/fetch/close, search_after pagination
│   │       ├── clickhouse.js # INSERT, query, dedup check, row count
│   │       └── metrics.js    # 60s sliding window EPS/MB tracker
│   ├── tests/
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx           # Routes + PrivateRoute guard
│   │   ├── api.js            # Fetch wrapper + JWT headers + 401 redirect
│   │   ├── pages/
│   │   │   ├── Login.jsx
│   │   │   ├── Dashboard.jsx
│   │   │   ├── Pipelines.jsx
│   │   │   ├── PipelineEditor.jsx
│   │   │   ├── Connections.jsx
│   │   │   ├── Clusters.jsx
│   │   │   └── Jobs.jsx      # Live Audit Feed + Copy All + Reset
│   │   └── components/
│   │       └── Shell.jsx     # App shell + nav + logout
│   └── package.json
├── sql/
│   └── wazuh_alerts_raw.sql  # ClickHouse table DDL
├── ecosystem.config.js       # PM2 config
├── backend/.env.example      # Environment variable template
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
