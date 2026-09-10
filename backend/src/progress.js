// In-memory live progress for chunk-queue runs (runScheduledSlices).
//
// Single-process architecture: the runner mutates a plain object here as workers claim
// and finish chunks; the API serializes a snapshot on demand. No DB, no coordinator —
// the object simply reflects the live in-memory queue state. One entry per pipeline
// (the scheduler guarantees at most one run per pipeline at a time). The last run's
// final state is kept until the next run overwrites it, so the UI can show the result.

const registry = new Map(); // pipelineId -> live progress object

function start(pipelineId, p) {
  registry.set(Number(pipelineId), p);
}

function clear(pipelineId) {
  registry.delete(Number(pipelineId));
}

// Serialize the current state (safe to call any time, during or after a run).
function snapshot(pipelineId) {
  const p = registry.get(Number(pipelineId));
  if (!p) return null;
  const chunks = (p.chunks || []).map(c => ({
    id: c.id,
    gte: c.gte,
    end: c.lt || c.lte,
    state: c.state,                 // PENDING | IN_PROGRESS | COMPLETE | FAILED
    redistributions: c.redistributions,
    indices: Array.isArray(c.indices) ? c.indices.length : null, // routed index count (null=full pattern)
    fetched: c.fetched,
    inserted: c.inserted,
  }));
  const complete = chunks.filter(c => c.state === 'COMPLETE').length;
  const failed = chunks.filter(c => c.state === 'FAILED').length;
  const total = chunks.length;
  return {
    pipeline_id: p.pipelineId,
    running: p.running,
    started_at: p.startedAt,
    ended_at: p.endedAt || null,
    window: p.window,               // { from, to }
    worker_count: p.workerCount,
    chunk_count: p.chunkCount,
    index_routed: p.indexRouted,
    indices_discovered: p.indicesDiscovered,
    max_run_minutes: p.maxRunMinutes,
    workers: p.workers,             // [{ id, status, current_chunk, current_range, completed, retries }]
    chunks,
    complete,
    failed,
    total,
    pct: total ? Math.floor((complete / total) * 100) : 0,
    final_status: p.finalStatus,    // COMPLETE | INCOMPLETE | FAILED | CANCELLED | null(running)
  };
}

module.exports = { start, clear, snapshot };
