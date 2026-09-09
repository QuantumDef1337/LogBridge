const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'logbridge.db');

let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    initSchema();
    configureDurability();
    registerShutdown();
  }
  return db;
}

// Force any WAL contents into the main .db file so data survives an unclean kill.
function checkpoint() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.error('WAL checkpoint failed:', e.message);
  }
}

let checkpointTimer = null;
let shutdownRegistered = false;

function configureDurability() {
  // WAL: allows the API and the Rust shipper to read/write concurrently.
  db.exec('PRAGMA journal_mode = WAL');
  // FULL: every commit is fsynced — a config DB has low write volume, so favor safety.
  db.exec('PRAGMA synchronous = FULL');
  // Wait up to 5s for a lock instead of throwing "database is locked" (two writers).
  db.exec('PRAGMA busy_timeout = 5000');
  // Checkpoint the WAL into the main file every 256 pages (~1 MB) instead of the 4 MB default.
  db.exec('PRAGMA wal_autocheckpoint = 256');
  // Fold any WAL left over from a previous run into the main .db right now.
  checkpoint();
  // Safety net: flush the WAL to disk every 10 seconds while running.
  if (!checkpointTimer) {
    checkpointTimer = setInterval(checkpoint, 10000);
    checkpointTimer.unref?.();
  }
}

function registerShutdown() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const close = (signal) => {
    checkpoint();
    try { db.close(); } catch {}
    if (signal) process.exit(0);
  };
  process.on('SIGINT', () => close('SIGINT'));
  process.on('SIGTERM', () => close('SIGTERM'));
  process.on('beforeExit', () => close(null));
}

// Add a column to a table only if it does not already exist (safe re-runnable migration).
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function initSchema() {
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA foreign_keys = ON`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS opensearch_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      tls_verify INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clickhouse_clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      default_database TEXT NOT NULL DEFAULT 'default',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pipelines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'paused',
      opensearch_connection_id INTEGER REFERENCES opensearch_connections(id) ON DELETE SET NULL,
      index_pattern TEXT NOT NULL DEFAULT '',
      index_set_filter TEXT DEFAULT '[]',
      pull_mode TEXT DEFAULT 'continuous',
      pull_from_date TEXT DEFAULT NULL,
      pull_to_date TEXT DEFAULT NULL,
      clickhouse_cluster_id INTEGER REFERENCES clickhouse_clusters(id) ON DELETE SET NULL,
      clickhouse_database TEXT NOT NULL DEFAULT '',
      clickhouse_table TEXT NOT NULL DEFAULT '',
      field_mappings TEXT DEFAULT '[]',
      customer_source TEXT DEFAULT 'field',
      customer_value TEXT DEFAULT '_customer',
      product_source TEXT DEFAULT 'field',
      product_value TEXT DEFAULT '_product',
      batch_mode TEXT DEFAULT 'both',
      batch_size INTEGER DEFAULT 2000,
      batch_timeout_ms INTEGER DEFAULT 5000,
      dedup_enabled INTEGER DEFAULT 1,
      dedup_field TEXT DEFAULT 'raw_data',
      dedup_algo TEXT DEFAULT 'md5',
      poll_interval_secs INTEGER DEFAULT 30,
      retry_count INTEGER DEFAULT 3,
      pause_on_fail INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pipeline_status (
      pipeline_id INTEGER PRIMARY KEY REFERENCES pipelines(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'idle',
      last_run_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      rows_inserted_total INTEGER DEFAULT 0,
      rows_inserted_today INTEGER DEFAULT 0,
      rows_inserted_week INTEGER DEFAULT 0,
      rows_skipped_dedup INTEGER DEFAULT 0,
      cursor_timestamp TEXT,
      cursor_id TEXT,
      oldest_source_ts TEXT,
      newest_source_ts TEXT,
      source_doc_count INTEGER DEFAULT 0,
      bytes_processed INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pipeline_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id INTEGER REFERENCES pipelines(id) ON DELETE CASCADE,
      level TEXT DEFAULT 'info',
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pipeline_logs_pid ON pipeline_logs(pipeline_id, created_at);

    -- Dead Letter Queue: events that could not be processed, never silently dropped.
    CREATE TABLE IF NOT EXISTS pipeline_dlq (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id INTEGER REFERENCES pipelines(id) ON DELETE CASCADE,
      source_index TEXT DEFAULT '',
      source_doc_id TEXT DEFAULT '',
      event_timestamp TEXT,
      document TEXT NOT NULL,
      error_message TEXT DEFAULT '',
      error_category TEXT DEFAULT 'unknown',
      retry_count INTEGER DEFAULT 0,
      first_failure_at TEXT DEFAULT (datetime('now')),
      last_failure_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'pending'
    );

    CREATE INDEX IF NOT EXISTS idx_pipeline_dlq_pid ON pipeline_dlq(pipeline_id, status, id);

    -- Per-physical-index checkpoint state.
    -- When a pipeline has specific indexes defined (index_set_filter), each index
    -- gets its own row here with independent cursor/progress/error state.
    -- The parent pipeline_status holds aggregate totals only.
    CREATE TABLE IF NOT EXISTS pipeline_indexes (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id             INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      index_name              TEXT NOT NULL,
      status                  TEXT DEFAULT 'idle',
      cursor_timestamp        TEXT,
      cursor_id               TEXT,
      checkpoint_sort         TEXT,
      checkpoint_committed_at TEXT,
      rows_inserted           INTEGER DEFAULT 0,
      rows_dlq                INTEGER DEFAULT 0,
      last_error              TEXT,
      last_run_at             TEXT,
      pit_id                  TEXT,
      UNIQUE(pipeline_id, index_name)
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_indexes_pid ON pipeline_indexes(pipeline_id);
  `);

  // Enrich pipeline_status with durable-checkpoint fields (idempotent add-column migration).
  addColumnIfMissing('pipeline_status', 'checkpoint_index', 'TEXT');
  addColumnIfMissing('pipeline_status', 'checkpoint_sort', 'TEXT');       // JSON: last search_after sort values
  addColumnIfMissing('pipeline_status', 'checkpoint_committed_at', 'TEXT');
  addColumnIfMissing('pipeline_status', 'last_batch_size', 'INTEGER DEFAULT 0');
  addColumnIfMissing('pipeline_status', 'rows_dlq', 'INTEGER DEFAULT 0');
  addColumnIfMissing('pipeline_status', 'rows_failed', 'INTEGER DEFAULT 0');
  addColumnIfMissing('pipeline_status', 'pit_id', 'TEXT');
  addColumnIfMissing('pipeline_status', 'last_run_duration_ms', 'INTEGER DEFAULT 0');
  addColumnIfMissing('pipeline_status', 'event_lag_secs', 'REAL DEFAULT NULL'); // now - cursor_timestamp at commit time
  addColumnIfMissing('pipelines', 'timestamp_field', "TEXT DEFAULT '@timestamp'");

  // Seed default admin user
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (userCount.c === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', hash);
    console.log('Default user created: admin / admin123');
  }
}

module.exports = { getDb, checkpoint };
