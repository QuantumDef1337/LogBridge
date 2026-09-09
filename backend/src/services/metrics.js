/**
 * In-process metrics collector.
 * Tracks events-per-second and bytes-per-second using a 60-second sliding window
 * of 1-second buckets. No external dependencies — zero overhead unless callers
 * actively record events.
 */

const WINDOW_SECS = 60;
const startedAt = Date.now();

// Ring buffer: one bucket per second
const eventBuckets = new Array(WINDOW_SECS).fill(0);
const bytesBuckets = new Array(WINDOW_SECS).fill(0);
let lastBucketSec = Math.floor(Date.now() / 1000);

function currentSec() {
  return Math.floor(Date.now() / 1000);
}

// Advance the ring buffer to the current second, zeroing any stale buckets.
function advanceBuckets() {
  const now = currentSec();
  const diff = now - lastBucketSec;
  if (diff <= 0) return;
  const steps = Math.min(diff, WINDOW_SECS);
  for (let i = 1; i <= steps; i++) {
    const idx = (lastBucketSec + i) % WINDOW_SECS;
    eventBuckets[idx] = 0;
    bytesBuckets[idx] = 0;
  }
  lastBucketSec = now;
}

/**
 * Record that `count` events and `bytes` bytes were processed right now.
 * Called by the runner after each successful ClickHouse insert.
 */
function recordIngestion(count, bytes) {
  advanceBuckets();
  const idx = currentSec() % WINDOW_SECS;
  eventBuckets[idx] += count;
  bytesBuckets[idx] += bytes;
}

/**
 * Compute current EPS and MB/s over the last `windowSecs` seconds (max 60).
 */
function getRate(windowSecs = 60) {
  advanceBuckets();
  const w = Math.min(windowSecs, WINDOW_SECS);
  const now = currentSec();
  let totalEvents = 0;
  let totalBytes = 0;
  for (let i = 1; i <= w; i++) {
    const idx = (now - i + WINDOW_SECS * 100) % WINDOW_SECS;
    totalEvents += eventBuckets[idx];
    totalBytes += bytesBuckets[idx];
  }
  return {
    window_secs: w,
    events_per_sec: parseFloat((totalEvents / w).toFixed(2)),
    mb_per_sec: parseFloat((totalBytes / w / 1024 / 1024).toFixed(4)),
    events_total_window: totalEvents,
    bytes_total_window: totalBytes,
  };
}

function getUptimeSeconds() {
  return Math.floor((Date.now() - startedAt) / 1000);
}

module.exports = { recordIngestion, getRate, getUptimeSeconds, startedAt };
