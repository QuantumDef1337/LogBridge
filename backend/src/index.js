'use strict';

const express = require('express');
const cors = require('cors');
const { getDb, checkpoint } = require('./db');
const scheduler = require('./scheduler');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Init DB on startup (creates schema, seeds admin user if needed)
getDb();

// After any successful write request, flush the WAL immediately so
// saved configuration is durable rather than waiting for the periodic timer.
app.use((req, res, next) => {
  if (req.method === 'GET') return next();
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) checkpoint();
  });
  next();
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/connections', require('./routes/connections'));
app.use('/api/clusters', require('./routes/clusters'));
app.use('/api/pipelines', require('./routes/pipelines'));
app.use('/api/jobs', require('./routes/jobs'));

// Health, readiness, and metrics (no auth — safe for monitoring scrapers)
app.use('/api', require('./routes/health'));

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`LogBridge API running on http://localhost:${PORT}`);
  // Start the background scheduler AFTER the server is listening.
  // It will immediately pick up any pipelines that were active before restart.
  scheduler.start();
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// SIGTERM (Docker/systemd stop) and SIGINT (Ctrl-C / Windows console close).
// Order: stop accepting connections → stop scheduler (waits for current batches)
//        → flush WAL → exit.
// The db.js module already registered its own SIGINT/SIGTERM handlers for the
// WAL checkpoint; we add the scheduler layer on top.

let exiting = false;

async function gracefulExit(signal) {
  if (exiting) return;
  exiting = true;
  console.log(`\n[logbridge] received ${signal} — starting graceful shutdown`);

  // 1. Stop accepting new HTTP requests
  server.close();

  // 2. Signal scheduler to stop and wait for running batches (max 30s)
  await scheduler.shutdown(30000);

  // 3. Flush WAL and close SQLite (db.js handlers also do this, but be explicit)
  try { checkpoint(); } catch {}

  console.log('[logbridge] shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT',  () => gracefulExit('SIGINT'));

// Log unhandled rejections instead of crashing (Node 15+ crashes by default).
// A crashed process under PM2 causes restart loops; this keeps the process alive
// and surfaces the error in logs so it can be diagnosed and fixed properly.
process.on('unhandledRejection', (reason) => {
  console.error('[logbridge] unhandledRejection — process kept alive:', reason);
});
