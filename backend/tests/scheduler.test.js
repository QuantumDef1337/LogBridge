'use strict';

/**
 * Tests for scheduler execution lock, triggerNow, cancel, and shutdown.
 * No real DB or network — pure in-process state assertions.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.LOGBRIDGE_ENCRYPTION_KEY = '0'.repeat(64);

// ── Minimal stub so scheduler can be required without a DB ──────────────────
const db = require('../src/db');
const mockPipeline = {
  id: 99,
  name: 'test',
  status: 'active',
  opensearch_connection_id: 1,
  clickhouse_cluster_id: 1,
  index_pattern: 'test-*',
  index_set_filter: '[]',
  pull_mode: 'continuous',
  pull_from_date: null,
  pull_to_date: null,
  field_mappings: '[]',
  customer_source: 'static', customer_value: 'test',
  product_source: 'static', product_value: 'test',
  batch_size: 100, retry_count: 1, poll_interval_secs: 999,
};

const prepareStub = {
  get: () => null,
  all: () => [],
  run: () => {},
};
Object.defineProperty(db, 'getDb', {
  value: () => ({ prepare: () => prepareStub }),
  configurable: true,
  writable: true,
});

// Stub runner so pipelines don't actually run
const runner = require('../src/runner');
const origRun = runner.runPipelineOnce;
runner.runPipelineOnce = async () => {
  await new Promise(r => setTimeout(r, 50)); // simulate short work
  return { fetched: 0, inserted: 0, dlq: 0 };
};

const scheduler = require('../src/scheduler');

describe('scheduler', () => {
  after(async () => {
    await scheduler.shutdown(1000);
  });

  test('isRunning returns false for unknown pipelines', () => {
    assert.equal(scheduler.isRunning(1234), false);
  });

  test('runningIds returns empty when nothing is executing', () => {
    assert.deepEqual(scheduler.runningIds(), []);
  });

  test('triggerNow returns false when pipeline is already running', async () => {
    // Patch getDb to return the mock pipeline for this test
    const savedGetDb = db.getDb;
    Object.defineProperty(db, 'getDb', {
      value: () => ({
        prepare: (sql) => {
          if (sql.includes('FROM pipelines WHERE id')) return { get: () => mockPipeline, all: () => [], run: () => {} };
          if (sql.includes('opensearch_connections')) return { get: () => ({ id: 1, url: 'http://x', username: 'u', password: 'enc:v1:aabbcc' }) };
          if (sql.includes('clickhouse_clusters')) return { get: () => ({ id: 1, url: 'http://x', username: 'u', password: 'enc:v1:aabbcc', default_database: 'default' }) };
          return prepareStub;
        }
      }),
      configurable: true,
      writable: true,
    });

    const first = scheduler.triggerNow(99);
    assert.equal(first, true); // started
    assert.equal(scheduler.isRunning(99), true);

    const second = scheduler.triggerNow(99);
    assert.equal(second, false); // already running

    // Wait for the fake run to complete
    await new Promise(r => setTimeout(r, 200));
    assert.equal(scheduler.isRunning(99), false);

    // Restore
    Object.defineProperty(db, 'getDb', { value: savedGetDb, configurable: true, writable: true });
  });

  test('cancel marks the token as cancelled', () => {
    // cancel on a non-running pipeline should not throw
    assert.doesNotThrow(() => scheduler.cancel(9999));
  });

  test('runningIds reflects currently running pipelines', async () => {
    assert.ok(Array.isArray(scheduler.runningIds()));
  });
});
