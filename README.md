# LogBridge

**LogBridge** is an open-source log shipping and management platform that streams logs from **OpenSearch / Wazuh Indexer** into **ClickHouse** for long-term, high-compression storage and analytics.

Built with Node.js 24, React 18, and SQLite — zero external dependencies for metadata storage.

---

## Features

- **Pipeline-based architecture** — configure source (OpenSearch) → destination (ClickHouse) pipelines via a web UI
- **Multi-page batching** — accumulates multiple OpenSearch PIT pages into one ClickHouse insert (Graylog-style), bypassing the 10K `max_result_window` limit
- **Durable checkpointing** — checkpoint committed only after ClickHouse acknowledges the insert; no data loss on crash
- **Per-index partitioning** — each daily index has its own independent cursor and checkpoint
- **Dead Letter Queue (DLQ)** — failed rows are never silently dropped; they are stored for inspection and retry
- **Deduplication** — optional MD5/SHA-256 event_id dedup against ClickHouse before insert
- **Circuit breaker awareness** — detects OpenSearch JVM heap OOM (circuit_breaking_exception) and stops retrying immediately instead of hammering a struggling node
- **Reconciliation** — compares OpenSearch source counts vs ClickHouse destination counts per index
- **JWT authentication** — login page, protected API routes, encrypted credential storage (AES-256-GCM)
- **Live Audit Feed** — real-time log feed with per-batch source index, inserted rows, from/to timestamps, copy button, and reset
- **Metrics** — 60-second sliding window EPS and MB/s tracking

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

1. Open a PIT on the source index pattern
2. Fetch N pages of up to 10,000 docs each (configurable — default 2 pages = 20K docs)
3. Transform docs using field mappings defined in the pipeline
4. Dedup-check event IDs against ClickHouse (optional)
5. Single bulk insert into ClickHouse via `INSERT ... FORMAT JSONEachRow`
6. Commit checkpoint to SQLite only after ClickHouse ACK
7. Repeat until caught up, then wait `poll_interval_secs`

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
node --version   # should print v24.x.x
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
npm run build   # outputs to frontend/dist/
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

> **Important:** Never commit `.env` or `logbridge.key` to version control. The encryption key is used to encrypt all stored OpenSearch and ClickHouse credentials with AES-256-GCM.

### 7. Serve the frontend with Nginx (recommended)

Install Nginx:

```bash
sudo apt-get install -y nginx
```

Create a site config at `/etc/nginx/sites-available/logbridge`:

```nginx
server {
    listen 80;
    server_name your-server-ip-or-domain;

    # Serve the React build
    root /opt/logbridge/frontend/dist;
    index index.html;

    # React Router — all paths fall through to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API calls to the Node backend
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

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/logbridge /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 8. Create PM2 ecosystem config

Create `ecosystem.config.js` at the root of the repo:

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
```

Create the logs directory:

```bash
mkdir -p logs
```

### 9. Start with PM2

```bash
pm2 start ecosystem.config.js
pm2 save                    # persist across reboots
pm2 startup                 # follow the printed command to enable on boot
```

Check it is running:

```bash
pm2 status
pm2 logs logbridge-backend --lines 50
```

### 10. Verify

Open your browser at `http://your-server-ip` (or `http://localhost:4000` for the raw API).

Default login: **admin / admin123**

> Change the default password immediately after first login via Settings.

---

## ClickHouse — Create target tables

Run this SQL in ClickHouse to create a raw archives table:

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

## Pipeline configuration

1. **Connections** — add your OpenSearch / Wazuh Indexer credentials
2. **Clusters** — add your ClickHouse cluster credentials
3. **Pipelines** — create a pipeline:
   - Select source connection + index pattern (e.g. `wazuh-archives-*`)
   - Select destination cluster + database + table
   - Configure field mappings (source field → ClickHouse column)
   - Set batch size (default 20,000 — uses 2 × 10K OpenSearch pages per insert)
   - Set pull mode: `from_date` (continuous) or `date_range` (historical backfill)
4. **Start** the pipeline — monitor progress in **Jobs → Live Audit Feed**

---

## Performance

| Metric | Value |
|---|---|
| Batch size | 20,000 rows (2 × 10K OS pages) |
| Sustained throughput | ~600–1,200 rows/sec (depends on OS index density) |
| ClickHouse compression | ~43× (ZSTD — 24 GB uncompressed → 551 MB on-disk) |
| ClickHouse insert timeout | 120 seconds |

**OpenSearch heap note:** Each PIT scan loads shard data into OS JVM heap. For index patterns spanning many daily indices (e.g. `wazuh-archives-*` across 30 days), the OS node should have at least **4 GB JVM heap** (`-Xms4g -Xmx4g` in `jvm.options`). Lower heap causes `circuit_breaking_exception` which LogBridge detects and handles gracefully (no retry storm).

---

## PM2 operations reference

```bash
pm2 status                          # show all processes
pm2 logs logbridge-backend          # tail live logs
pm2 restart logbridge-backend       # restart after config change
pm2 stop logbridge-backend          # stop
pm2 delete logbridge-backend        # remove from PM2
pm2 monit                           # live CPU/memory dashboard
```

---

## Project structure

```
LogBridge/
├── backend/
│   ├── src/
│   │   ├── index.js          # Express server + graceful shutdown
│   │   ├── db.js             # SQLite schema + WAL mode
│   │   ├── scheduler.js      # Per-pipeline execution loop
│   │   ├── runner.js         # PIT fetch + transform + CH insert
│   │   ├── retry.js          # Exponential backoff + error classification
│   │   ├── auth.js           # JWT sign/verify + requireAuth middleware
│   │   ├── crypto.js         # AES-256-GCM credential encryption
│   │   ├── audit.js          # Pipeline audit log helpers
│   │   ├── routes/
│   │   │   ├── auth.js       # POST /api/auth/login, change-password
│   │   │   ├── pipelines.js  # Pipeline CRUD + run/pause/reconcile
│   │   │   ├── connections.js
│   │   │   ├── clusters.js
│   │   │   ├── jobs.js       # Pipeline logs + status
│   │   │   └── health.js     # GET /api/health, /api/metrics
│   │   └── services/
│   │       ├── opensearch.js # PIT open/fetch/close, search_after
│   │       ├── clickhouse.js # INSERT, query, dedup check
│   │       └── metrics.js    # 60s sliding window EPS/MB tracker
│   ├── tests/
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx           # Routes + PrivateRoute guard
│   │   ├── api.js            # Axios-style fetch wrapper + JWT headers
│   │   ├── pages/
│   │   │   ├── Login.jsx
│   │   │   ├── Dashboard.jsx
│   │   │   ├── Pipelines.jsx
│   │   │   ├── PipelineEditor.jsx
│   │   │   ├── Connections.jsx
│   │   │   ├── Clusters.jsx
│   │   │   └── Jobs.jsx      # Live Audit Feed
│   │   └── components/
│   │       └── Shell.jsx     # App shell + nav + logout
│   └── package.json
├── sql/
│   └── wazuh_alerts_raw.sql  # ClickHouse table DDL
├── ecosystem.config.js       # PM2 config
└── README.md
```

---

## Security notes

- All OpenSearch and ClickHouse credentials are encrypted at rest with **AES-256-GCM** using a key stored in `backend/logbridge.key` or the `LOGBRIDGE_ENCRYPTION_KEY` environment variable
- Passwords are **never returned** in API GET responses
- JWT tokens expire (configurable in `auth.js`)
- All API routes require a valid JWT except `POST /api/auth/login`

---

## License

MIT
