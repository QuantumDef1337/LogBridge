'use strict';

/**
 * Tests for opensearch service — discoverIndexes glob matching.
 * Tests the pure filter logic without live network calls by extracting the
 * regex conversion used inside discoverIndexes.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Re-implement the same glob→regex logic that discoverIndexes uses internally,
// so we can test it in isolation without needing a live OpenSearch connection.
function globToRegex(pattern) {
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    + '$';
  return new RegExp(regexStr, 'i');
}

function filterIndexes(indexes, pattern) {
  if (!pattern || pattern === '*') return indexes;
  const re = globToRegex(pattern);
  return indexes.filter(i => re.test(i.index));
}

const fakeIndices = [
  { index: 'wazuh-alerts-4.x-2026.01.01', 'docs.count': '1000' },
  { index: 'wazuh-alerts-4.x-2026.01.02', 'docs.count': '2000' },
  { index: 'wazuh-alerts-4.x-2026.02.01', 'docs.count': '500'  },
  { index: 'firewall-logs-2026.01.01',     'docs.count': '3000' },
  { index: '.internal-index',              'docs.count': '0'    },
];

describe('discoverIndexes — glob filter logic', () => {
  test('no pattern returns all indexes', () => {
    const result = filterIndexes(fakeIndices, '');
    assert.equal(result.length, fakeIndices.length);
  });

  test('* pattern returns all indexes', () => {
    const result = filterIndexes(fakeIndices, '*');
    assert.equal(result.length, fakeIndices.length);
  });

  test('exact name match returns just that index', () => {
    const result = filterIndexes(fakeIndices, 'firewall-logs-2026.01.01');
    assert.equal(result.length, 1);
    assert.equal(result[0].index, 'firewall-logs-2026.01.01');
  });

  test('wildcard * matches multiple indexes', () => {
    const result = filterIndexes(fakeIndices, 'wazuh-alerts-4.x-*');
    assert.equal(result.length, 3);
    assert.ok(result.every(r => r.index.startsWith('wazuh-alerts-4.x-')));
  });

  test('month-scoped wildcard filters correctly', () => {
    const result = filterIndexes(fakeIndices, 'wazuh-alerts-4.x-2026.01.*');
    assert.equal(result.length, 2);
  });

  test('pattern with no matches returns empty array', () => {
    const result = filterIndexes(fakeIndices, 'does-not-exist-*');
    assert.deepEqual(result, []);
  });

  test('dot-prefixed internal index matched when pattern includes leading dot', () => {
    const result = filterIndexes(fakeIndices, '.internal-*');
    assert.equal(result.length, 1);
    assert.equal(result[0].index, '.internal-index');
  });

  test('question-mark wildcard matches single character', () => {
    // wazuh-alerts-4.x-2026.01.0? should match 01 and 02
    const result = filterIndexes(fakeIndices, 'wazuh-alerts-4.x-2026.01.0?');
    assert.equal(result.length, 2);
  });
});
