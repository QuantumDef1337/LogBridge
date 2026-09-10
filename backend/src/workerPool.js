'use strict';

/**
 * LogBridge V2 — Worker Thread Pool.
 *
 * Manages a fixed pool of Worker Threads (one per logical worker slot).
 * Threads are long-lived — spawned once at pool creation and reused across
 * chunk assignments, avoiding per-chunk thread spawn overhead.
 *
 * Main thread responsibilities handled here:
 *   - Spawn / terminate threads
 *   - Route PROCESS_CHUNK messages to idle threads
 *   - Receive CHUNK_COMPLETE / CHUNK_FAILED / CHUNK_CANCELLED messages
 *   - Forward LOG messages to pipelineLog (SQLite, main thread)
 *   - Forward DLQ messages to toDlq (SQLite, main thread)
 *   - Forward METRICS messages to metrics.recordIngestion
 *   - Update live progress on PROGRESS messages
 */

const path            = require('path');
const { Worker, SharedArrayBuffer: SAB, Int32Array: I32 } = require('worker_threads');

const WORKER_SCRIPT = path.join(__dirname, 'workerThread.js');

class WorkerPool {
  /**
   * @param {number}   size          Number of threads to spawn.
   * @param {object}   sharedOpts    conn, cluster, pipeline, opts — passed to every thread.
   * @param {object}   handlers      { pipelineLog, toDlq, metricsRecord, onProgress }
   */
  constructor(size, sharedOpts, handlers) {
    this._size     = size;
    this._handlers = handlers;

    // Shared stop flag — main thread sets [0]=1 to signal all threads to stop.
    // Int32Array over SharedArrayBuffer so the write is visible cross-thread.
    this._stopBuf  = new SharedArrayBuffer(4);
    this._stopFlag = new Int32Array(this._stopBuf);

    // PIT semaphore — limits concurrent OpenSearch PIT opens across ALL threads.
    // Without this, all N threads open PITs simultaneously, hitting OpenSearch's
    // max_open_scroll_context limit (default 500) and getting 429 errors.
    // Each thread acquires one slot before openPit() and releases it after.
    // Default to 2 — conservative enough for local/small OpenSearch (157 indices × 2 PITs
    // = ~314 scroll contexts, well under the default max_open_scroll_context of 500).
    // Raise via pipeline config maxConcurrentPits on large production clusters.
    const maxConcurrentPits = sharedOpts.opts.maxConcurrentPits || 2;
    this._pitSemBuf  = new SharedArrayBuffer(4);
    this._pitSem     = new Int32Array(this._pitSemBuf);
    Atomics.store(this._pitSem, 0, maxConcurrentPits);

    this._threads = [];
    for (let i = 0; i < size; i++) {
      this._threads.push(this._spawnThread(i, sharedOpts));
    }

    // Queue of pending { chunk, resolve, reject } waiting for a free thread.
    this._pendingChunks = [];
    // Map<threadIndex, { resolve, reject, chunkId }> — in-flight assignments.
    this._inFlight = new Map();
    // Which thread indices are currently idle.
    this._idle = Array.from({ length: size }, (_, i) => i);
  }

  _spawnThread(workerId, sharedOpts) {
    const worker = new Worker(WORKER_SCRIPT, {
      workerData: {
        workerId,
        stopFlag: this._stopFlag,  // shared memory stop signal
        pitSem:   this._pitSem,    // PIT open semaphore (cross-thread atomic)
        conn:     sharedOpts.conn,
        cluster:  sharedOpts.cluster,
        pipeline: sharedOpts.pipeline,
        opts:     sharedOpts.opts,
      },
    });

    worker.on('message', (msg) => this._handleMessage(workerId, msg));
    worker.on('error',   (err) => this._handleThreadError(workerId, err));
    worker.on('exit',    (code) => {
      if (code !== 0 && !this._terminating) {
        this._handleThreadError(workerId, new Error(`Worker thread ${workerId} exited with code ${code}`));
      }
    });

    return worker;
  }

  _handleMessage(workerId, msg) {
    const h = this._handlers;

    switch (msg.type) {
      case 'LOG':
        h.pipelineLog(msg.level, msg.message);
        break;

      case 'DLQ':
        h.toDlq(msg.docs, msg.error);
        break;

      case 'METRICS':
        h.metricsRecord(msg.inserted, msg.bytes);
        break;

      case 'CURSOR_UPDATE':
        // Keep the chunk's resume cursor current so redistribution re-starts from
        // the last safely-inserted page, not the beginning of the chunk.
        h.onCursorUpdate(msg.chunkId, msg.cursorTs, msg.cursorId);
        break;

      case 'PROGRESS':
        // Display-only update — does not affect chunk inserted/fetched totals
        // (those come from CHUNK_COMPLETE to avoid double-counting).
        h.onProgress(msg.chunkId, msg.fetched, msg.inserted);
        break;

      case 'CHUNK_COMPLETE':
      case 'CHUNK_FAILED':
      case 'CHUNK_CANCELLED': {
        const inflight = this._inFlight.get(workerId);
        if (!inflight) break;
        this._inFlight.delete(workerId);
        this._idle.push(workerId);

        if (msg.type === 'CHUNK_COMPLETE') {
          inflight.resolve({ ok: true, result: msg.result });
        } else if (msg.type === 'CHUNK_CANCELLED') {
          inflight.resolve({ ok: false, cancelled: true });
        } else {
          inflight.resolve({ ok: false, failed: true });
        }

        // Drain the pending queue if a thread just freed up.
        this._drainQueue();
        break;
      }
    }
  }

  _handleThreadError(workerId, err) {
    const inflight = this._inFlight.get(workerId);
    if (inflight) {
      this._inFlight.delete(workerId);
      this._idle.push(workerId);
      inflight.resolve({ ok: false, failed: true, error: err.message });
    }
    this._drainQueue();
  }

  _drainQueue() {
    while (this._pendingChunks.length > 0 && this._idle.length > 0) {
      const { chunk, resolve, reject } = this._pendingChunks.shift();
      const threadIdx = this._idle.pop();
      this._assign(threadIdx, chunk, resolve, reject);
    }
  }

  _assign(threadIdx, chunk, resolve, reject) {
    this._inFlight.set(threadIdx, { resolve, reject, chunkId: chunk.id });
    this._threads[threadIdx].postMessage({ type: 'PROCESS_CHUNK', chunk });
  }

  /**
   * Submit a chunk for processing. Returns a Promise that resolves with
   * { ok: true, result } on success or { ok: false, failed/cancelled } on failure.
   * If all threads are busy the chunk is queued and processed when one frees up.
   */
  process(chunk) {
    return new Promise((resolve, reject) => {
      if (this._idle.length > 0) {
        const threadIdx = this._idle.pop();
        this._assign(threadIdx, chunk, resolve, reject);
      } else {
        this._pendingChunks.push({ chunk, resolve, reject });
      }
    });
  }

  /** Signal all threads to stop after their current batch completes. */
  requestStop() {
    Atomics.store(this._stopFlag, 0, 1);
  }

  /** Terminate all threads immediately. Call after all work is done. */
  async terminate() {
    this._terminating = true;
    this.requestStop();
    await Promise.all(this._threads.map(w => w.terminate().catch(() => {})));
  }
}

module.exports = WorkerPool;
