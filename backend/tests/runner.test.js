'use strict';

/**
 * Tests for runner.js transform, DLQ, and checkpoint logic.
 * All I/O is stubbed — no live OpenSearch or ClickHouse needed.
 */

const { test, describe, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.LOGBRIDGE_ENCRYPTION_KEY = '0'.repeat(64);

// ── Stub the DB so runner can be required without a real SQLite file ──────────
const fakeDb = {
  prepare: () => ({
    run: () => {},
    get: () => null,
    all: () => [],
  }),
};
// Override getDb to return fakeDb before requiring runner
const db = require('../src/db');
// Monkey-patch for testing — runner calls getDb() lazily
const origGetDb = db.getDb;
Object.defineProperty(db, 'getDb', { value: () => fakeDb, configurable: true });

const { transformDoc, buildRange } = require('../src/runner');

describe('transformDoc', () => {
  const pipeline = {
    id: 1,
    field_mappings: [
      { dest: 'event_time', source_type: 'field', source_value: '@timestamp' },
      { dest: 'raw',        source_type: 'full_doc' },
      { dest: 'host',       source_type: 'field',  source_value: 'agent.name' },
      { dest: 'env',        source_type: 'static', source_value: 'prod' },
    ],
    customer_source: 'static',
    customer_value: 'acme',
    product_source: 'static',
    product_value:  'firewall',
    dedup_enabled: true,
    dedup_field:   '@timestamp',
    dedup_algo:    'md5',
  };

  test('maps top-level fields correctly', () => {
    const doc = { '@timestamp': '2025-01-01T00:00:00Z', agent: { name: 'srv1' } };
    const row = transformDoc(doc, pipeline);
    assert.equal(row.event_time, '2025-01-01T00:00:00Z');
    assert.equal(row.host, 'srv1');
  });

  test('static source type injects fixed value', () => {
    const row = transformDoc({ '@timestamp': 't' }, pipeline);
    assert.equal(row.env, 'prod');
  });

  test('full_doc source type JSON-encodes the whole document', () => {
    const doc = { '@timestamp': 't', msg: 'hi' };
    const row = transformDoc(doc, pipeline);
    assert.ok(typeof row.raw === 'string');
    const parsed = JSON.parse(row.raw);
    assert.equal(parsed['@timestamp'], 't');
  });

  test('auto-injects customer and product from static source', () => {
    const row = transformDoc({ '@timestamp': 't' }, pipeline);
    assert.equal(row.customer, 'acme');
    assert.equal(row.product, 'firewall');
  });

  test('omits undefined/null/empty fields so ClickHouse DEFAULT applies', () => {
    const pipelineMissingField = {
      ...pipeline,
      field_mappings: [{ dest: 'host', source_type: 'field', source_value: 'agent.name' }],
    };
    const doc = {}; // agent.name not present
    const row = transformDoc(doc, pipelineMissingField);
    assert.ok(!('host' in row), 'missing field should be omitted');
  });

  test('computes event_id via md5 when dedup_enabled and field is present', () => {
    const doc = { '@timestamp': '2025-01-01T00:00:00Z' };
    const row = transformDoc(doc, pipeline);
    assert.ok(typeof row.event_id === 'string' && row.event_id.length === 32);
  });

  test('event_id hashes whole doc when dedup field is absent/empty', () => {
    const pipelineDedup = {
      ...pipeline,
      dedup_field: 'nonexistent',
      field_mappings: [],
    };
    const doc = { '@timestamp': 't', x: 1 };
    const row1 = transformDoc(doc, pipelineDedup);
    const doc2 = { '@timestamp': 't', x: 2 }; // different doc
    const row2 = transformDoc(doc2, pipelineDedup);
    assert.notEqual(row1.event_id, row2.event_id); // must differ
  });

  test('nested dot-path resolution', () => {
    const p = {
      ...pipeline,
      field_mappings: [{ dest: 'level', source_type: 'field', source_value: 'a.b.c' }],
    };
    const doc = { a: { b: { c: 42 } } };
    const row = transformDoc(doc, p);
    assert.equal(row.level, 42);
  });
});

describe('buildRange', () => {
  test('continuous mode returns empty range', () => {
    const range = buildRange({ pull_mode: 'continuous' });
    assert.deepEqual(range, {});
  });

  test('from_date mode sets gte', () => {
    const range = buildRange({ pull_mode: 'from_date', pull_from_date: '2025-01-01T00:00:00Z' });
    assert.equal(range.gte, '2025-01-01T00:00:00Z');
    assert.ok(!('lte' in range));
  });

  test('date_range mode sets gte and lte', () => {
    const range = buildRange({
      pull_mode: 'date_range',
      pull_from_date: '2025-01-01T00:00:00Z',
      pull_to_date: '2025-01-31T00:00:00Z',
    });
    assert.equal(range.gte, '2025-01-01T00:00:00Z');
    assert.equal(range.lte, '2025-01-31T00:00:00Z');
  });
});
